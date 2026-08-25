import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  decodeErrorResult,
  decodeFunctionData,
  encodeErrorResult,
  parseAbi,
  toFunctionSelector,
} from 'viem'

import {
  encodeSetFraxChainIdToEid,
  getRevertData,
  parseFraxMappings,
} from './fraxChainIdMappings'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(`${REPO_ROOT}/${path}`, 'utf8')) as T

interface IFraxConfig {
  hop: Record<string, string>
  mappings: { chainId: number; lzEid: number }[]
}

const fraxConfig = readJson<IFraxConfig>('config/frax.json')
const networks = readJson<Record<string, { chainId: number }>>(
  'config/networks.json'
)

describe('config/frax.json', () => {
  // Every chain in `hop` is a routable Frax destination, but only chains present in
  // `mappings` get an EID written into diamond storage by initFrax/setFraxChainIdToEid.
  // A hop entry without a mapping therefore reverts UnsupportedChainId at bridge time
  // on every diamond.
  it('has a mappings entry for every chain listed under hop', () => {
    const mapped = new Set(fraxConfig.mappings.map((m) => m.chainId))

    const unknown: string[] = []
    const missing: string[] = []
    for (const network of Object.keys(fraxConfig.hop)) {
      const chainId = networks[network]?.chainId
      if (chainId === undefined) unknown.push(network)
      else if (!mapped.has(chainId)) missing.push(network)
    }

    // reported together: an unknown hop entry must not mask a missing mapping
    expect({ missing, unknown }).toEqual({ missing: [], unknown: [] })
  })

  it('has no duplicate or zero-EID mappings', () => {
    const chainIds = fraxConfig.mappings.map((m) => m.chainId)
    expect(new Set(chainIds).size).toBe(chainIds.length)
    // lzEid 0 collides with the facet's "unset" sentinel and is rejected on-chain
    expect(fraxConfig.mappings.filter((m) => m.lzEid <= 0)).toEqual([])
  })
})

describe('parseFraxMappings', () => {
  it('parses the committed config', () => {
    const parsed = parseFraxMappings(fraxConfig)
    expect(parsed.length).toBe(fraxConfig.mappings.length)
    expect(parsed.map((m) => Number(m.chainId))).toEqual(
      fraxConfig.mappings.map((m) => m.chainId)
    )
  })

  it('rejects a zero lzEid', () => {
    expect(() =>
      parseFraxMappings({ mappings: [{ chainId: 1, lzEid: 0 }] })
    ).toThrow(/lzEid=0/)
  })

  it('rejects an lzEid past the on-chain uint32', () => {
    expect(() =>
      parseFraxMappings({ mappings: [{ chainId: 988, lzEid: 0x100000000 }] })
    ).toThrow(/lzEid=4294967296/)
    // the boundary value itself stays valid
    expect(
      parseFraxMappings({ mappings: [{ chainId: 988, lzEid: 0xffffffff }] })[0]
        ?.lzEid
    ).toBe(0xffffffff)
  })

  it('rejects a zero chainId', () => {
    expect(() =>
      parseFraxMappings({ mappings: [{ chainId: 0, lzEid: 30101 }] })
    ).toThrow(/chainId=0/)
  })

  it('rejects a config without mappings', () => {
    expect(() => parseFraxMappings({})).toThrow(/missing mappings/)
  })
})

describe('encodeSetFraxChainIdToEid', () => {
  it('round-trips the chainId/lzEid tuples', () => {
    const mappings = [
      { chainId: 988n, lzEid: 30396 },
      { chainId: 747474n, lzEid: 30375 },
    ]

    const decoded = decodeFunctionData({
      abi: parseAbi([
        'function setFraxChainIdToEid((uint256 chainId, uint32 lzEid)[] chainIdConfigs)',
      ]),
      data: encodeSetFraxChainIdToEid(mappings),
    })

    expect(decoded.functionName).toBe('setFraxChainIdToEid')
    expect(decoded.args[0]).toEqual(mappings)
    // named-tuple decoding is order-independent, so only the selector pins the
    // ChainIdConfig field order; a swap would encode a call that reverts on-chain
    expect(encodeSetFraxChainIdToEid(mappings).slice(0, 10)).toBe('0xa8e13b68')
  })
})

describe('diamond revert selectors', () => {
  // The propose task tells UnsupportedChainId (mapping unset -> propose it) apart from
  // FunctionDoesNotExist (facet not cut in yet -> abort with an actionable message).
  // Both are decoded from raw bytes, so the selectors must match the deployed contracts.
  it('matches the selectors the contracts actually revert with', () => {
    expect(toFunctionSelector('UnsupportedChainId(uint256)')).toBe('0xa5dab5fe')
    expect(toFunctionSelector('FunctionDoesNotExist()')).toBe('0xa9ad62f8')
  })

  it('decodes each revert payload to the right error', () => {
    const abi = parseAbi([
      'error UnsupportedChainId(uint256 chainId)',
      'error FunctionDoesNotExist()',
    ])

    expect(
      decodeErrorResult({
        abi,
        data: encodeErrorResult({
          abi,
          errorName: 'UnsupportedChainId',
          args: [988n],
        }),
      }).errorName
    ).toBe('UnsupportedChainId')

    expect(decodeErrorResult({ abi, data: '0xa9ad62f8' }).errorName).toBe(
      'FunctionDoesNotExist'
    )
  })
})

describe('getRevertData', () => {
  it('reads the raw revert bytes viem parks on `raw`', () => {
    // viem's ContractFunctionRevertedError defines `data` as present-but-undefined
    // and carries the bytes on `raw`, so an `in` check would short-circuit here
    const revertedError: Record<string, unknown> = {
      data: undefined,
      raw: '0xa5dab5fe',
    }
    expect('data' in revertedError).toBe(true)
    expect(getRevertData({ cause: revertedError })).toBe('0xa5dab5fe')
  })

  it('returns undefined when there is no revert payload', () => {
    expect(getRevertData(new Error('over rate limit'))).toBeUndefined()
  })
})
