import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, expect, it } from 'bun:test'
import {
  decodeFunctionData,
  encodeErrorResult,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  encodeTimelockScheduleBatch,
} from '../deploy/safe/timelock-abi'

import {
  ALL_BRIDGE_ERRORS_ABI,
  buildMappingRepairCalls,
  getRevertData,
  getStaleAllBridgeKeys,
  isUnsupportedAllBridgeChainIdRevert,
  loadAllBridgeMappings,
  parseAllBridgeMappings,
  selectMappingsNeedingUpdate,
  selectResolvingStaleKeys,
  type MappingReadResult,
} from './allBridgeChainIdMappings'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const allBridgeConfig = JSON.parse(
  readFileSync(`${REPO_ROOT}/config/allbridge.json`, 'utf8')
) as { mappings: Array<{ chainId: number; allBridgeChainId: number }> }

const configMappings = parseAllBridgeMappings(allBridgeConfig)

const DIAMOND: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const SALT: Hex = `0x${'11'.repeat(32)}`

// Signatures pinned independently of the module so a drift in its ABIs shows up here
const DIAMOND_ABI = parseAbi([
  'function setChainIdToAllBridgeChainId((uint256 chainId, uint256 allBridgeChainId)[] chainIdConfigs)',
  'function unsetChainIdToAllBridgeChainId(uint256 _chainId)',
])

const UNSUPPORTED_REVERT: MappingReadResult = {
  status: 'failure',
  error: {
    cause: {
      data: undefined,
      raw: encodeErrorResult({
        abi: ALL_BRIDGE_ERRORS_ABI,
        errorName: 'UnsupportedAllBridgeChainId',
      }),
    },
  },
}

const resolves = (value: bigint): MappingReadResult => ({
  status: 'success',
  result: value,
})

describe('loadAllBridgeMappings', () => {
  it('loads the committed config from the repository root', () => {
    const cwd = process.cwd()
    process.chdir(REPO_ROOT)
    try {
      expect(loadAllBridgeMappings()).toEqual(configMappings)
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('parseAllBridgeMappings', () => {
  it('parses every row of the committed config by field name', () => {
    expect(configMappings.length).toBe(allBridgeConfig.mappings.length)
    expect(
      configMappings.find((m) => m.chainId === 1201081091099710n)
        ?.allBridgeChainId
    ).toBe(7)
    expect(
      configMappings.find((m) => m.chainId === 137n)?.allBridgeChainId
    ).toBe(5)
  })

  it('rejects a zero allBridgeChainId', () => {
    expect(() =>
      parseAllBridgeMappings({
        mappings: [{ chainId: 1, allBridgeChainId: 0 }],
      })
    ).toThrow(/allBridgeChainId=0/)
  })

  it('rejects a zero chainId', () => {
    expect(() =>
      parseAllBridgeMappings({
        mappings: [{ chainId: 0, allBridgeChainId: 1 }],
      })
    ).toThrow(/chainId=0/)
  })

  it('rejects a config without mappings', () => {
    expect(() => parseAllBridgeMappings({})).toThrow(/missing mappings/)
    expect(() => parseAllBridgeMappings({ mappings: [] })).toThrow(
      /No mappings found/
    )
  })
})

describe('getStaleAllBridgeKeys', () => {
  it('lists every allBridgeChainId of the real config that is not also a chainId', () => {
    // 1 and 10 are excluded: Ethereum and Optimism map to themselves, so the correct
    // set call overwrites those keys
    expect(getStaleAllBridgeKeys(configMappings)).toEqual([
      2n,
      3n,
      4n,
      5n,
      6n,
      7n,
      8n,
      9n,
      11n,
      12n,
      13n,
      14n,
      17n,
    ])
  })

  it('lists a repeated allBridgeChainId once', () => {
    expect(
      getStaleAllBridgeKeys([
        { chainId: 100n, allBridgeChainId: 3 },
        { chainId: 200n, allBridgeChainId: 3 },
      ])
    ).toEqual([3n])
  })
})

describe('selectMappingsNeedingUpdate', () => {
  const mappings = [
    { chainId: 137n, allBridgeChainId: 5 },
    { chainId: 130n, allBridgeChainId: 14 },
    { chainId: 1n, allBridgeChainId: 1 },
  ]

  it('keeps rows that are unset or differ, drops rows that match', () => {
    expect(
      selectMappingsNeedingUpdate(mappings, [
        UNSUPPORTED_REVERT,
        resolves(130n),
        resolves(1n),
      ])
    ).toEqual(mappings.slice(0, 2))
  })

  it('throws on any other read failure', () => {
    expect(() =>
      selectMappingsNeedingUpdate(mappings, [
        { status: 'failure', error: new Error('over rate limit') },
        resolves(14n),
        resolves(1n),
      ])
    ).toThrow(/Failed to read chainId 137: over rate limit/)
  })

  it('redacts endpoints embedded in a read failure', () => {
    const endpoint = 'https://rpc.example.invalid/v2/sekret'
    let thrown: unknown
    try {
      selectMappingsNeedingUpdate(mappings, [
        {
          status: 'failure',
          error: new Error(`HTTP request failed. URL: ${endpoint}`),
        },
        resolves(14n),
        resolves(1n),
      ])
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('[redacted-url]')
    expect((thrown as Error).message).not.toContain(endpoint)
  })

  it('throws when the result count does not match', () => {
    expect(() => selectMappingsNeedingUpdate(mappings, [])).toThrow(
      /Expected 3 read results/
    )
  })
})

describe('selectResolvingStaleKeys', () => {
  it('keeps keys that resolve and drops keys that revert UnsupportedAllBridgeChainId', () => {
    expect(
      selectResolvingStaleKeys(
        [5n, 14n, 17n],
        [resolves(137n), UNSUPPORTED_REVERT, resolves(59144n)]
      )
    ).toEqual([5n, 17n])
  })

  it('throws on any other read failure', () => {
    expect(() =>
      selectResolvingStaleKeys(
        [5n],
        [{ status: 'failure', error: { raw: '0xa9ad62f8' } }]
      )
    ).toThrow(/Failed to read chainId 5/)
  })

  it('throws when the result count does not match', () => {
    expect(() => selectResolvingStaleKeys([5n, 14n], [resolves(137n)])).toThrow(
      /Expected 2 read results, got 1/
    )
  })
})

describe('repair batch', () => {
  const decodeBatch = (calldata: Hex) => {
    const { functionName, args } = decodeFunctionData({
      abi: TIMELOCK_SCHEDULE_BATCH_ABI,
      data: calldata,
    })
    expect(functionName).toBe('scheduleBatch')
    const [targets, values, payloads] = args
    return {
      targets,
      values,
      calls: payloads.map((p) =>
        decodeFunctionData({ abi: DIAMOND_ABI, data: p })
      ),
    }
  }

  it('sets the correct rows first, then unsets each stale key that resolves', () => {
    // An inverted seed: every config row is wrong or unset, and every stale key except
    // 13 resolves (13 stands in for a key a previous repair already removed)
    const staleKeys = getStaleAllBridgeKeys(configMappings)
    const mappingsToSet = selectMappingsNeedingUpdate(
      configMappings,
      configMappings.map((m) =>
        m.chainId === BigInt(m.allBridgeChainId)
          ? resolves(m.chainId)
          : UNSUPPORTED_REVERT
      )
    )
    const staleKeysToUnset = selectResolvingStaleKeys(
      staleKeys,
      staleKeys.map((key) => (key === 13n ? UNSUPPORTED_REVERT : resolves(1n)))
    )

    const calls = buildMappingRepairCalls({
      diamondAddress: DIAMOND,
      mappingsToSet,
      staleKeysToUnset,
    })
    const batch = decodeBatch(
      encodeTimelockScheduleBatch(
        calls.targets,
        calls.payloads,
        SALT,
        10800n, // 3 hours
        calls.values
      )
    )

    expect(batch.targets).toEqual(calls.payloads.map(() => DIAMOND))
    expect(batch.values).toEqual(calls.payloads.map(() => 0n))

    const [setCall, ...unsetCalls] = batch.calls
    expect(setCall?.functionName).toBe('setChainIdToAllBridgeChainId')
    expect(setCall?.args[0]).toEqual(
      configMappings
        .filter((m) => m.chainId !== BigInt(m.allBridgeChainId))
        .map((m) => ({
          chainId: m.chainId,
          allBridgeChainId: BigInt(m.allBridgeChainId),
        }))
    )

    expect(unsetCalls.map((c) => c.functionName)).toEqual(
      staleKeysToUnset.map(() => 'unsetChainIdToAllBridgeChainId')
    )
    expect(unsetCalls.map((c) => c.args[0])).toEqual([
      2n,
      3n,
      4n,
      5n,
      6n,
      7n,
      8n,
      9n,
      11n,
      12n,
      14n,
      17n,
    ])
  })

  it('unsets stale keys even when no row needs setting', () => {
    const calls = buildMappingRepairCalls({
      diamondAddress: DIAMOND,
      mappingsToSet: [],
      staleKeysToUnset: [14n],
    })

    const batch = decodeBatch(
      encodeTimelockScheduleBatch(calls.targets, calls.payloads, SALT, 0n)
    )
    expect(batch.calls).toEqual([
      { functionName: 'unsetChainIdToAllBridgeChainId', args: [14n] },
    ])
  })

  it('produces no calls when every row is correct and no stale key resolves', () => {
    const staleKeys = getStaleAllBridgeKeys(configMappings)
    const calls = buildMappingRepairCalls({
      diamondAddress: DIAMOND,
      mappingsToSet: selectMappingsNeedingUpdate(
        configMappings,
        configMappings.map((m) => resolves(BigInt(m.allBridgeChainId)))
      ),
      staleKeysToUnset: selectResolvingStaleKeys(
        staleKeys,
        staleKeys.map(() => UNSUPPORTED_REVERT)
      ),
    })

    expect(calls).toEqual({ targets: [], values: [], payloads: [] })
  })
})

describe('diamond selectors and reverts', () => {
  it('matches the selectors AllBridgeFacet exposes', () => {
    const { payloads } = buildMappingRepairCalls({
      diamondAddress: DIAMOND,
      mappingsToSet: [{ chainId: 137n, allBridgeChainId: 5 }],
      staleKeysToUnset: [5n],
    })

    expect(payloads.map((p) => p.slice(0, 10))).toEqual([
      '0xa62ef168',
      '0x37f6bf4e',
    ])
    expect(
      encodeErrorResult({
        abi: ALL_BRIDGE_ERRORS_ABI,
        errorName: 'UnsupportedAllBridgeChainId',
      })
    ).toBe(toFunctionSelector('UnsupportedAllBridgeChainId()'))
  })

  it('recognises only UnsupportedAllBridgeChainId as an unset key', () => {
    expect(isUnsupportedAllBridgeChainIdRevert(UNSUPPORTED_REVERT.error)).toBe(
      true
    )
    expect(isUnsupportedAllBridgeChainIdRevert({ raw: '0xa9ad62f8' })).toBe(
      false
    )
    expect(isUnsupportedAllBridgeChainIdRevert(new Error('timeout'))).toBe(
      false
    )
  })
})

describe('getRevertData', () => {
  it('reads the raw revert bytes viem parks on `raw`', () => {
    expect(getRevertData({ cause: { data: undefined, raw: '0x1234' } })).toBe(
      '0x1234'
    )
  })

  it('prefers `data` when it holds the bytes', () => {
    expect(getRevertData({ data: '0xabcd' })).toBe('0xabcd')
  })

  it('returns undefined when there is no revert payload', () => {
    expect(getRevertData(new Error('over rate limit'))).toBeUndefined()
    expect(getRevertData(undefined)).toBeUndefined()
  })
})
