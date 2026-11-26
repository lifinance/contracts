/**
 * Gate G on Tron: a `scheduleBatch(diamondCut)` against a base58 deployment
 * record and `tronWallets`, observed at sign time and graded the way
 * `confirm-safe-tx.ts` grades it, plus the same inputs through the
 * pre-broadcast gate the executor runs.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import {
  authorityExpectationAnchors,
  storageAuthorityCheckResult,
} from './confirm-check-registry'
import { storageAuthorityDefiniteReds } from './definite-red-gate'
import type { IObservationDependencies } from './prebroadcast-gate'
import { runPreBroadcastGate } from './prebroadcast-gate'
import { toSignedAuthorityEntries } from './signed-set-record'
import {
  observeSignTimeSet,
  type ISignTimeSetDependencies,
  type TSetObservation,
} from './sign-time-authority-observation'
import { gateAddressInputsForNetwork, tronHex } from './tron-gate-addresses'

const NETWORK = 'tron'

/** Mainnet `deployments/tron.json` values, as main spells them. */
const DEPLOYMENTS_BASE58 = {
  LiFiDiamond: 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
  LiFiTimelockController: 'TBzBFjsCh3LJh9avAKy9oF3StZMn4hUBhu',
  OwnershipFacet: 'TVofq5iFiwsDf4M3xcucpV7HCX5M6XpcHW',
}

/** Checksum-valid base58 under version byte 0x42, not Tron's 0x41. */
const OTHER_VERSION_BASE58 = 'TbKcWzjyNreUq3ub5hQFKUbCX7wyoDAGww'

const TRON_PAUSER_BASE58 = 'TYkGtJi7iQqMvtyeMhhHUCiGfsRExKnAkd'
const TRON_REFUND_BASE58 = 'TBvVg3Aam5QP2XE3XCatgatjefXvsYf6yD'
const ATTACKER = '0x00000000000000000000000000000000000000ee'

/**
 * EVM wallets deliberately different from the Tron ones, so an expectation
 * read from the EVM side instead of `tronWallets` cannot pass.
 */
const GLOBAL_CONFIG = {
  pauserWallet: '0x00000000000000000000000000000000000000b2',
  refundWallet: '0x00000000000000000000000000000000000000b3',
  tronWallets: {
    pauserWallet: TRON_PAUSER_BASE58,
    refundWallet: TRON_REFUND_BASE58,
  },
}

const DIAMOND = tronHex(NETWORK, DEPLOYMENTS_BASE58.LiFiDiamond).toLowerCase()
const TIMELOCK = tronHex(
  NETWORK,
  DEPLOYMENTS_BASE58.LiFiTimelockController
).toLowerCase()
const FACET = tronHex(NETWORK, DEPLOYMENTS_BASE58.OwnershipFacet).toLowerCase()
const TRON_PAUSER = tronHex(NETWORK, TRON_PAUSER_BASE58).toLowerCase()

const DIAMOND_CUT = encodeFunctionData({
  abi: parseAbi([
    'function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)',
  ]),
  functionName: 'diamondCut',
  args: [
    [
      {
        facetAddress: FACET as Address,
        action: 1,
        functionSelectors: ['0x8da5cb5b'],
      },
    ],
    '0x0000000000000000000000000000000000000000',
    '0x',
  ],
})

const SCHEDULE_BATCH: Hex = encodeFunctionData({
  abi: parseAbi([
    'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  ]),
  functionName: 'scheduleBatch',
  args: [
    [DIAMOND as Address],
    [0n],
    [DIAMOND_CUT],
    `0x${'00'.repeat(32)}`,
    `0x${'01'.repeat(32)}`,
    10_800n,
  ],
})

/** A chain that matches what main declares unless a test changes it. */
const healthyAuthorities = (): Record<string, string> => ({
  [`${DIAMOND}:owner`]: TIMELOCK,
  [`${DIAMOND}:pauserWallet`]: TRON_PAUSER,
})

const readersOver = (
  authorities: Record<string, string>
): Pick<IObservationDependencies, 'readCode' | 'readAuthority'> => ({
  readCode: async () => `0x${'11'.repeat(32)}`,
  readAuthority: async (address: Address, getter: string) => {
    const value = authorities[`${address.toLowerCase()}:${getter}`]
    if (value === undefined) throw new Error(`execution reverted: ${getter}()`)
    return value
  },
})

const dependencies = (
  overrides: Partial<ISignTimeSetDependencies> = {}
): ISignTimeSetDependencies => ({
  readers: () => readersOver(healthyAuthorities()),
  loadDeployments: async () => ({ ...DEPLOYMENTS_BASE58 }),
  readPinnedDeployments: async () => ({
    ok: true,
    value: { ...DEPLOYMENTS_BASE58 },
  }),
  globalConfig: GLOBAL_CONFIG,
  ...overrides,
})

const observed = (read: TSetObservation) => {
  if (read.kind !== 'observed')
    throw new Error(`expected an observation, got ${JSON.stringify(read)}`)
  return read.observation.observed
}

/** The row and the definite reds `confirm-safe-tx.ts` derives from a read. */
const grade = (read: TSetObservation) => {
  const { authorities } = observed(read)
  const entries = toSignedAuthorityEntries(authorities)
  return {
    authorities,
    row: storageAuthorityCheckResult(
      entries,
      NETWORK,
      authorityExpectationAnchors(authorities)
    ),
    reds: storageAuthorityDefiniteReds(entries),
  }
}

describe('observeSignTimeSet on Tron', () => {
  it('reads the diamond a Tron diamond cut targets, yielding authority rows', async () => {
    const { authorities } = grade(
      await observeSignTimeSet(NETWORK, SCHEDULE_BATCH, dependencies())
    )
    expect(authorities.map((authority) => authority.label)).toEqual(
      expect.arrayContaining([
        'LiFiDiamond.owner()',
        'LiFiDiamond.pauserWallet()',
      ])
    )
  })

  it('passes when the owner is the timelock and the pauser is the Tron pauser wallet', async () => {
    const { row, reds } = grade(
      await observeSignTimeSet(NETWORK, SCHEDULE_BATCH, dependencies())
    )
    expect(row.status).toBe('pass')
    expect(reds).toEqual([])
  })

  it('is a definite red when the owner is not the timelock', async () => {
    const authorities = healthyAuthorities()
    authorities[`${DIAMOND}:owner`] = ATTACKER
    const { row, reds } = grade(
      await observeSignTimeSet(
        NETWORK,
        SCHEDULE_BATCH,
        dependencies({ readers: () => readersOver(authorities) })
      )
    )
    expect(row.status).toBe('fail')
    expect(reds.map((red) => red.gate)).toContain('G')
  })

  // The expectation side must be `tronWallets`: a pauser equal to the EVM
  // wallet is wrong on Tron.
  it('is a definite red when the pauser is the EVM pauser wallet', async () => {
    const authorities = healthyAuthorities()
    authorities[`${DIAMOND}:pauserWallet`] = GLOBAL_CONFIG.pauserWallet
    const { reds } = grade(
      await observeSignTimeSet(
        NETWORK,
        SCHEDULE_BATCH,
        dependencies({ readers: () => readersOver(authorities) })
      )
    )
    expect(reds.map((red) => red.gate)).toContain('G')
  })

  it('blocks when the authority reader throws', async () => {
    const { row, reds } = grade(
      await observeSignTimeSet(
        NETWORK,
        SCHEDULE_BATCH,
        dependencies({ readers: () => readersOver({}) })
      )
    )
    expect(row.status).toBe('error')
    expect(reds).toEqual([])
  })

  it('is read-failed when no reader can be built', async () => {
    const read = await observeSignTimeSet(
      NETWORK,
      SCHEDULE_BATCH,
      dependencies({
        readers: () => {
          throw new Error('Could not find RPC URL for network tron')
        },
      })
    )
    expect(read).toEqual({
      kind: 'absent',
      absence: {
        kind: 'read-failed',
        reason: 'Could not find RPC URL for network tron',
      },
    })
  })

  it.each([
    [
      'a deployment',
      {
        loadDeployments: async () => ({
          ...DEPLOYMENTS_BASE58,
          OwnershipFacet: OTHER_VERSION_BASE58,
        }),
      },
    ],
    [
      'a pinned deployment',
      {
        readPinnedDeployments: async () => ({
          ok: true as const,
          value: {
            ...DEPLOYMENTS_BASE58,
            LiFiTimelockController: OTHER_VERSION_BASE58,
          },
        }),
      },
    ],
    [
      'a Tron wallet',
      {
        globalConfig: {
          ...GLOBAL_CONFIG,
          tronWallets: { pauserWallet: TRON_PAUSER_BASE58 },
        },
      },
    ],
  ])(
    'is read-failed, never an empty set, when %s will not convert to hex',
    async (_what, overrides: Partial<ISignTimeSetDependencies>) => {
      const read = await observeSignTimeSet(
        NETWORK,
        SCHEDULE_BATCH,
        dependencies(overrides)
      )
      expect(read.kind).toBe('absent')
      if (read.kind === 'absent') expect(read.absence.kind).toBe('read-failed')
    }
  )

  it('is not-scheduled for calldata that schedules no batch', async () => {
    expect(
      await observeSignTimeSet(NETWORK, DIAMOND_CUT, dependencies())
    ).toEqual({ kind: 'absent', absence: { kind: 'not-scheduled' } })
  })
})

describe('runPreBroadcastGate on Tron inputs', () => {
  const OPERATION = {
    operationId: `0x${'aa'.repeat(32)}`,
    targets: [DIAMOND],
    payloads: [DIAMOND_CUT],
  }

  const gateDependencies = (authorities: Record<string, string>) => ({
    ...readersOver(authorities),
    ...gateAddressInputsForNetwork(NETWORK, {
      deployments: { ...DEPLOYMENTS_BASE58 },
      pinnedDeployments: { ...DEPLOYMENTS_BASE58 },
      globalConfig: GLOBAL_CONFIG,
    }),
    signTimeRecord: { operationId: OPERATION.operationId },
    readScheduledAt: async () => 1_700_000_000n,
  })

  it('proceeds when every authority matches', async () => {
    const result = await runPreBroadcastGate(
      OPERATION,
      gateDependencies(healthyAuthorities())
    )
    expect(result.disposition).toBe('PROCEED')
  })

  it('blocks when the owner is not the timelock, as on EVM', async () => {
    const authorities = healthyAuthorities()
    authorities[`${DIAMOND}:owner`] = ATTACKER
    const result = await runPreBroadcastGate(
      OPERATION,
      gateDependencies(authorities)
    )
    expect(result.disposition).toBe('BLOCK')
    expect(result.blocksBroadcast).toBe(true)
  })
})
