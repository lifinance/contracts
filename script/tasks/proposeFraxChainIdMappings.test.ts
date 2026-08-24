import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { decodeFunctionData, parseAbi } from 'viem'

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
const networks = readJson<Record<string, { chainId: number; status: string }>>(
  'config/networks.json'
)

describe('config/frax.json', () => {
  // Every chain in `hop` is a routable Frax destination, but only chains present in
  // `mappings` get an EID written into diamond storage by initFrax/setFraxChainIdToEid.
  // A hop entry without a mapping therefore reverts UnsupportedChainId at bridge time
  // on every diamond, which is exactly how stable/tempo/somnia/katana shipped unusable.
  it('has a mappings entry for every chain listed under hop', () => {
    const mapped = new Set(fraxConfig.mappings.map((m) => m.chainId))

    const missing = Object.keys(fraxConfig.hop).filter((network) => {
      const chainId = networks[network]?.chainId
      if (chainId === undefined)
        throw new Error(
          `hop network "${network}" is not in config/networks.json`
        )
      return !mapped.has(chainId)
    })

    expect(missing).toEqual([])
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
  })
})

describe('getRevertData', () => {
  it('reads the raw revert bytes viem parks on `raw`', () => {
    expect(getRevertData({ cause: { raw: '0x1234' } })).toBe('0x1234')
  })

  it('returns undefined when there is no revert payload', () => {
    expect(getRevertData(new Error('over rate limit'))).toBeUndefined()
  })
})
