import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { afterAll, describe, expect, it } from 'bun:test'
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
import type { IAllBridgeChainIdConfig } from '../deploy/tron/helpers/allBridgeInit'

import {
  ALL_BRIDGE_ERRORS_ABI,
  assertMappingsInitialized,
  buildMappingRepairCalls,
  getRevertData,
  getStaleAllBridgeKeys,
  isUnsupportedAllBridgeChainIdRevert,
  loadAllBridgeMappings,
  selectMappingsNeedingUpdate,
  selectResolvingStaleKeys,
  type MappingReadResult,
} from './allBridgeChainIdMappings'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const configMappings = loadAllBridgeMappings(
  `${REPO_ROOT}/config/allbridge.json`
)

// Independent of config/allbridge.json so adding a chain there leaves these tests valid.
// Stale keys: 5, 14, 17, 13 (1 and 10 are also chainIds)
const FIXTURE_MAPPINGS: IAllBridgeChainIdConfig[] = [
  { chainId: 1n, allBridgeChainId: 1n },
  { chainId: 137n, allBridgeChainId: 5n },
  { chainId: 10n, allBridgeChainId: 10n },
  { chainId: 130n, allBridgeChainId: 14n },
  { chainId: 59144n, allBridgeChainId: 17n },
  { chainId: 9270000000000001n, allBridgeChainId: 13n },
]

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
  const tmpDir = mkdtempSync(join(tmpdir(), 'allbridge-mappings-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  const writeConfig = (name: string, content: string): string => {
    const filePath = join(tmpDir, name)
    writeFileSync(filePath, content)
    return filePath
  }

  it('loads config/allbridge.json from the working directory by default', () => {
    const cwd = process.cwd()
    process.chdir(REPO_ROOT)
    try {
      expect(loadAllBridgeMappings()).toEqual(configMappings)
    } finally {
      process.chdir(cwd)
    }
  })

  it('reads every row of the committed config by field name', () => {
    expect(
      configMappings.find((m) => m.chainId === 1201081091099710n)
        ?.allBridgeChainId
    ).toBe(7n)
    expect(
      configMappings.find((m) => m.chainId === 137n)?.allBridgeChainId
    ).toBe(5n)
  })

  it('keeps chainIds above 2^53 exact', () => {
    const filePath = writeConfig(
      'precision.json',
      '{"mappings":[{"chainId":9270000000000001,"allBridgeChainId":13}]}'
    )

    expect(loadAllBridgeMappings(filePath)).toEqual([
      { chainId: 9270000000000001n, allBridgeChainId: 13n },
    ])
  })

  it('rejects a duplicated chainId and names the file', () => {
    const filePath = writeConfig(
      'duplicate.json',
      '{"mappings":[{"chainId":137,"allBridgeChainId":5},{"chainId":137,"allBridgeChainId":6}]}'
    )

    expect(() => loadAllBridgeMappings(filePath)).toThrow(
      `${filePath}: mappings[1].chainId 137 is duplicated`
    )
  })

  it('names the file when the config has no mappings', () => {
    const filePath = writeConfig('empty.json', '{"mappings":[]}')

    expect(() => loadAllBridgeMappings(filePath)).toThrow(
      `${filePath}: config/allbridge.json has no non-empty "mappings" array`
    )
  })

  it('names the file when it cannot be read', () => {
    const filePath = join(tmpDir, 'missing.json')

    expect(() => loadAllBridgeMappings(filePath)).toThrow(`${filePath}: `)
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
        { chainId: 100n, allBridgeChainId: 3n },
        { chainId: 200n, allBridgeChainId: 3n },
      ])
    ).toEqual([3n])
  })
})

describe('selectMappingsNeedingUpdate', () => {
  const mappings = FIXTURE_MAPPINGS.slice(0, 3)

  it('keeps rows that are unset or differ, drops rows that match', () => {
    expect(
      selectMappingsNeedingUpdate(mappings, [
        resolves(1n),
        UNSUPPORTED_REVERT,
        resolves(137n),
      ])
    ).toEqual(mappings.slice(1))
  })

  it('throws on any other read failure', () => {
    expect(() =>
      selectMappingsNeedingUpdate(mappings, [
        { status: 'failure', error: new Error('over rate limit') },
        resolves(5n),
        resolves(10n),
      ])
    ).toThrow(/Failed to read chainId 1: over rate limit/)
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

describe('assertMappingsInitialized', () => {
  it('rejects a diamond on which no key resolves', () => {
    expect(() =>
      assertMappingsInitialized([UNSUPPORTED_REVERT, UNSUPPORTED_REVERT])
    ).toThrow(/initAllBridge has likely never run/)
  })

  it('accepts a diamond on which any key resolves', () => {
    expect(() =>
      assertMappingsInitialized([UNSUPPORTED_REVERT, resolves(137n)])
    ).not.toThrow()
  })

  it('leaves other read failures to the select helpers', () => {
    expect(() =>
      assertMappingsInitialized([
        UNSUPPORTED_REVERT,
        { status: 'failure', error: new Error('timeout') },
      ])
    ).not.toThrow()
    expect(() => assertMappingsInitialized([])).not.toThrow()
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
    const staleKeys = getStaleAllBridgeKeys(FIXTURE_MAPPINGS)
    const mappingsToSet = selectMappingsNeedingUpdate(
      FIXTURE_MAPPINGS,
      FIXTURE_MAPPINGS.map((m) =>
        m.chainId === m.allBridgeChainId
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
    expect(batch.calls).toEqual([
      {
        functionName: 'setChainIdToAllBridgeChainId',
        args: [
          [
            { chainId: 137n, allBridgeChainId: 5n },
            { chainId: 130n, allBridgeChainId: 14n },
            { chainId: 59144n, allBridgeChainId: 17n },
            { chainId: 9270000000000001n, allBridgeChainId: 13n },
          ],
        ],
      },
      { functionName: 'unsetChainIdToAllBridgeChainId', args: [5n] },
      { functionName: 'unsetChainIdToAllBridgeChainId', args: [14n] },
      { functionName: 'unsetChainIdToAllBridgeChainId', args: [17n] },
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
    const staleKeys = getStaleAllBridgeKeys(FIXTURE_MAPPINGS)
    const calls = buildMappingRepairCalls({
      diamondAddress: DIAMOND,
      mappingsToSet: selectMappingsNeedingUpdate(
        FIXTURE_MAPPINGS,
        FIXTURE_MAPPINGS.map((m) => resolves(m.allBridgeChainId))
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
      mappingsToSet: [{ chainId: 137n, allBridgeChainId: 5n }],
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
