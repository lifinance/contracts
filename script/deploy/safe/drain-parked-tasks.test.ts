/**
 * Tests for the deferred diamond-cleanup drain (drain-parked-tasks.ts).
 *
 * The pure `prepareDrainNetwork(...)` orchestration is exercised against fully
 * injected dependencies (queue reads/transitions, the removal engine, and
 * alert/log sinks) — no Mongo, no chain, no Safe client. The `proposeWithDrain`
 * orchestrator is driven with an injected queue opener and a fake `proposePrimary`
 * so the gate / fold-in / link / revert / best-effort-fallback paths are proven
 * without signing. Only the live adapter (`proposeWithDrain`'s default opener and
 * `buildLiveDeps`'s Mongo/Safe wiring) is unit-test exempt, mirroring the store
 * layer's `getParkedTasksCollection()` carve-out. The env gates
 * (`isDrainEnabled` / `isDirectSendEnv` / `isDrainEligible`) are covered directly.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type WithId } from 'mongodb'
import { type Address, type Hex } from 'viem'

import { EnvironmentEnum, type IProposeToSafeOptions } from '../../common/types'
import { buildDiamondCutRemoveCalldata } from '../../utils/viemScriptHelpers'

import { type IAddressRemovalResult } from './diamondRemovalDiff'
import {
  isDirectSendEnv,
  isDrainEligible,
  isDrainEnabled,
  prepareDrainNetwork,
  proposeWithDrain,
  type DrainOpener,
  type IDrainDeps,
  type ITimelockCall,
} from './drain-parked-tasks'
import { type IParkedTask } from './parked-tasks'

const NETWORK = 'arbitrum'
const PROD = EnvironmentEnum.production
const DIAMOND = '0x00000000000000000000000000000000000000dd' as Address
const addr = (n: number): Address =>
  `0x${n.toString(16).padStart(40, '0')}` as Address
const sel = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(8, '0')}` as `0x${string}`

/** Distinct per-facet address, so a task's identity is unique like it is in production. */
const facetAddr = (facetName: string): Address =>
  addr(
    [...facetName].reduce((acc, char) => acc * 31 + char.charCodeAt(0), 7) %
      0xffff
  )

function task(
  facetName: string,
  overrides: Partial<IParkedTask> = {}
): WithId<IParkedTask> {
  const facetAddress = overrides.facetAddress ?? facetAddr(facetName)
  return {
    taskKey: `facet-removal|${NETWORK}|production|${facetAddress.toLowerCase()}`,
    kind: 'facet-removal',
    network: NETWORK,
    environment: PROD,
    facetName,
    diamondAddress: DIAMOND,
    prUrl: `https://github.com/lifinance/contracts/pull/${facetName.length}`,
    status: 'queued',
    enqueuer: 'dev@li.finance',
    createdAt: new Date(),
    ...overrides,
    facetAddress,
  } as WithId<IParkedTask>
}

function removal(
  facetName: string,
  selectors = [sel(1)]
): IAddressRemovalResult['removals'][number] {
  return { name: facetName, address: facetAddr(facetName), selectors }
}

function addressResult(
  over: Partial<IAddressRemovalResult> = {}
): IAddressRemovalResult {
  return {
    network: NETWORK,
    environment: PROD,
    diamondAddress: DIAMOND,
    removals: [],
    notFoundOnChain: [],
    protectedSkipped: [],
    unverifiable: [],
    stillExpected: [],
    routedNames: new Set<string>(),
    routedAddresses: new Set<string>(),
    ...over,
  }
}

interface ISpyDeps extends IDrainDeps {
  calls: {
    claim: string[]
    supersede: string[]
    cancel: string[]
    revert: string[]
    link: { taskKey: string; safeTxHash: string }[]
    alerts: string[]
    logs: string[]
  }
}

function makeDeps(opts: {
  queued: WithId<IParkedTask>[]
  result: IAddressRemovalResult
  proposed?: WithId<IParkedTask>[]
  claimFails?: Set<string>
  claimThrowsOn?: string
}): ISpyDeps {
  const calls: ISpyDeps['calls'] = {
    claim: [],
    supersede: [],
    cancel: [],
    revert: [],
    link: [],
    alerts: [],
    logs: [],
  }
  const byKey = new Map(opts.queued.map((t) => [t.taskKey, t]))
  const deps: ISpyDeps = {
    calls,
    listQueued: async () => opts.queued,
    listProposed: async () => opts.proposed ?? [],
    computeRemovals: async () => opts.result,
    claim: async (taskKey) => {
      calls.claim.push(taskKey)
      if (opts.claimThrowsOn === taskKey)
        throw new Error(`claim blew up for ${taskKey}`)
      if (opts.claimFails?.has(taskKey)) return null
      const t = byKey.get(taskKey)
      return t ? ({ ...t, status: 'proposed' } as WithId<IParkedTask>) : null
    },
    supersede: async (taskKey) => {
      calls.supersede.push(taskKey)
    },
    cancel: async (taskKey) => {
      calls.cancel.push(taskKey)
    },
    revert: async (taskKey) => {
      calls.revert.push(taskKey)
    },
    linkProposal: async (taskKey, safeTxHash) => {
      calls.link.push({ taskKey, safeTxHash })
    },
    alert: (message) => {
      calls.alerts.push(message)
    },
    log: (message) => {
      calls.logs.push(message)
    },
  }
  return deps
}

describe('prepareDrainNetwork', () => {
  it('no-ops when nothing is queued (never touches the removal engine)', async () => {
    let computeCalled = false
    const deps = makeDeps({ queued: [], result: addressResult() })
    deps.computeRemovals = async () => {
      computeCalled = true
      return addressResult()
    }
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)
    expect(computeCalled).toBe(false)
    expect(prep.calls).toHaveLength(0)
    expect(prep.claimedTaskKeys).toHaveLength(0)
    expect(prep.parkedTaskRefs).toHaveLength(0)
  })

  it('claims a queued removal and returns one diamondCut Remove call carrying its origin PR', async () => {
    const t = task('OldFacet')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({ removals: [removal('OldFacet')] }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.claim).toEqual([t.taskKey])
    expect(prep.calls).toHaveLength(1)
    expect(prep.calls[0]?.to).toBe(DIAMOND)
    expect(prep.calls[0]?.calldata).toBe(
      buildDiamondCutRemoveCalldata([
        { name: 'OldFacet', selectors: [sel(1)] },
      ]) as Hex
    )
    expect(prep.parkedTaskRefs).toEqual([{ facet: 'OldFacet', prUrl: t.prUrl }])
    expect(prep.claimedTaskKeys).toEqual([t.taskKey])
    // Linking is the orchestrator's job — prepare never links.
    expect(deps.calls.link).toHaveLength(0)
  })

  it('emits ONE separate call per parked facet (N facets → N calls), each with its own PR', async () => {
    const a = task('FacetA', { prUrl: 'https://gh/pull/2046' })
    const b = task('FacetBB', { prUrl: 'https://gh/pull/2048' })
    const deps = makeDeps({
      queued: [a, b],
      result: addressResult({
        removals: [removal('FacetA', [sel(1)]), removal('FacetBB', [sel(2)])],
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(2)
    expect(prep.calls[0]?.calldata).toBe(
      buildDiamondCutRemoveCalldata([
        { name: 'FacetA', selectors: [sel(1)] },
      ]) as Hex
    )
    expect(prep.calls[1]?.calldata).toBe(
      buildDiamondCutRemoveCalldata([
        { name: 'FacetBB', selectors: [sel(2)] },
      ]) as Hex
    )
    expect(prep.parkedTaskRefs).toEqual([
      { facet: 'FacetA', prUrl: 'https://gh/pull/2046' },
      { facet: 'FacetBB', prUrl: 'https://gh/pull/2048' },
    ])
    expect(prep.claimedTaskKeys).toEqual([a.taskKey, b.taskKey])
  })

  it('folds one address in only once when two open tasks carry it', async () => {
    // Legacy rows keep the name-based `taskKey`, so the partial unique index
    // does not collide them with a re-enqueue of the same address. Two identical
    // Remove calls in one scheduleBatch would revert on the second, taking the
    // primary proposal with it.
    const shared = facetAddr('SymbiosisFacet')
    const first = task('SymbiosisFacet', { facetAddress: shared })
    const second = task('SymbiosisFacet', {
      facetAddress: shared,
      taskKey: 'facet-removal|arbitrum|production|SymbiosisFacet',
      prUrl: 'https://gh/pull/2199',
    })
    const deps = makeDeps({
      queued: [first, second],
      result: addressResult({ removals: [removal('SymbiosisFacet')] }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(1)
    expect(deps.calls.claim).toEqual([first.taskKey])
    expect(prep.claimedTaskKeys).toEqual([first.taskKey])
    expect(prep.outcome.duplicateAddresses).toEqual(['SymbiosisFacet'])
    // The duplicate stays queued — never superseded or cancelled behind the operator.
    expect(deps.calls.supersede).toEqual([])
    expect(deps.calls.cancel).toEqual([])
    expect(deps.calls.alerts.join('\n')).toContain(
      'another open task already carries this address'
    )
  })

  it('skips a queued task whose address a PROPOSED task already carries (pending proposal)', async () => {
    // Legacy shape: a name-keyed row sits in `proposed` under pending
    // proposal P1; a fresh address-keyed re-enqueue must not fold the same
    // Remove into a second proposal.
    const shared = facetAddr('SymbiosisFacet')
    const pending = task('SymbiosisFacet', {
      facetAddress: shared,
      taskKey: 'facet-removal|arbitrum|production|SymbiosisFacet',
      status: 'proposed',
    })
    const requeued = task('SymbiosisFacet', { facetAddress: shared })
    const deps = makeDeps({
      queued: [requeued],
      proposed: [pending],
      result: addressResult({ removals: [removal('SymbiosisFacet')] }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(0)
    expect(deps.calls.claim).toEqual([])
    expect(prep.outcome.duplicateAddresses).toEqual(['SymbiosisFacet'])
  })

  it('blocks a second same-address task even when the first claim was LOST', async () => {
    // A concurrent drain won task 1's claim; its Remove rides that drain's
    // proposal, so task 2 (same address, different key) must not be claimed here.
    const shared = facetAddr('SymbiosisFacet')
    const first = task('SymbiosisFacet', { facetAddress: shared })
    const second = task('SymbiosisFacet', {
      facetAddress: shared,
      taskKey: 'facet-removal|arbitrum|production|SymbiosisFacet',
    })
    const deps = makeDeps({
      queued: [first, second],
      result: addressResult({ removals: [removal('SymbiosisFacet')] }),
      claimFails: new Set([first.taskKey]),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.claim).toEqual([first.taskKey])
    expect(prep.calls).toHaveLength(0)
    expect(prep.outcome.skippedAlreadyClaimed).toEqual(['SymbiosisFacet'])
    expect(prep.outcome.duplicateAddresses).toEqual(['SymbiosisFacet'])
  })

  it('refuses a removal whose deploy-log name disagrees with the parked label', async () => {
    // The task was parked as AcrossFacetV3 but its stored address is the live
    // GenericSwapFacetV3 — removing it would take down the wrong facet under a
    // misleading label on every signer surface.
    const t = task('AcrossFacetV3')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({
        removals: [
          {
            name: 'GenericSwapFacetV3',
            address: t.facetAddress,
            selectors: [sel(1)],
          },
        ],
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(0)
    expect(deps.calls.claim).toEqual([])
    expect(prep.outcome.nameMismatch).toEqual(['AcrossFacetV3'])
    expect(deps.calls.alerts.join('\n')).toContain('disagree')
  })

  it('refuses a removal the engine reports as still expected by target state', async () => {
    const t = task('AcrossFacetV3')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({
        stillExpected: [
          {
            name: 'GenericSwapFacetV3',
            address: t.facetAddress,
            reason:
              'the deploy log names it GenericSwapFacetV3, which target state expects to stay registered',
          },
        ],
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(0)
    expect(deps.calls.claim).toEqual([])
    expect(deps.calls.supersede).toEqual([])
    expect(deps.calls.cancel).toEqual([])
    expect(prep.outcome.stillExpected).toEqual(['AcrossFacetV3'])
    expect(deps.calls.alerts.join('\n')).toContain('LIVE facet')
  })

  it('skips (and alerts on) a legacy task whose stored address is not a valid EVM address', async () => {
    const poison = task('TronFacet', {
      facetAddress: 'TW7Xj4Zt7ZWvhKQyPnzUnFyfLmTsMLGvBn' as Address,
    })
    const good = task('OldFacet')
    let requested: Address[] = []
    const deps = makeDeps({
      queued: [poison, good],
      result: addressResult({ removals: [removal('OldFacet')] }),
    })
    const inner = deps.computeRemovals
    deps.computeRemovals = async (addresses) => {
      requested = addresses
      return inner(addresses)
    }
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(requested.map((a) => a.toLowerCase())).toEqual([
      good.facetAddress.toLowerCase(),
    ])
    expect(prep.outcome.invalidAddresses).toEqual(['TronFacet'])
    expect(prep.calls).toHaveLength(1)
    expect(deps.calls.alerts.join('\n')).toContain('not a valid EVM address')
  })

  it('supersedes a task whose facet is already gone on-chain (no call emitted)', async () => {
    const t = task('GoneFacet')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({ notFoundOnChain: [t.facetAddress] }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.supersede).toEqual([t.taskKey])
    expect(prep.calls).toHaveLength(0)
    expect(prep.outcome.superseded).toEqual(['GoneFacet'])
  })

  it('refuses to supersede an absent address while its NAME is still routed', async () => {
    // The worldchain/lisk contamination shape: the task carries an address that was
    // never routed here, so the facet it was meant to remove is still on the diamond.
    const t = task('AcrossFacetV3')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({
        notFoundOnChain: [t.facetAddress],
        routedNames: new Set(['AcrossFacetV3']),
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.supersede).toEqual([])
    expect(prep.outcome.superseded).toEqual([])
    expect(prep.outcome.suspectSnapshots).toEqual(['AcrossFacetV3'])
    expect(deps.calls.alerts.join('\n')).toContain('NOT routed')
  })

  it('leaves a task queued when its protected status cannot be verified', async () => {
    // A missing artifact makes the protected-selector union unavailable. Cancelling
    // here would retire a legitimate removal over a tooling gap.
    const t = task('OldFacet')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({ unverifiable: [t.facetAddress] }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.cancel).toEqual([])
    expect(deps.calls.supersede).toEqual([])
    expect(deps.calls.claim).toEqual([])
    expect(prep.outcome.protectedCancelled).toEqual([])
    expect(prep.outcome.unverifiable).toEqual(['OldFacet'])
    expect(deps.calls.alerts.join('\n')).toContain('leaving it queued')
  })

  it('bails out entirely when the diamond could not be resolved', async () => {
    const t = task('GoneFacet')
    const deps = makeDeps({
      queued: [t],
      // The no-diamond early return: no chain read happened, so nothing is absent.
      result: addressResult({
        diamondAddress: undefined,
        diamondUnresolved: true,
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.supersede).toEqual([])
    expect(deps.calls.claim).toEqual([])
    expect(prep.calls).toHaveLength(0)
    expect(prep.outcome.superseded).toEqual([])
    expect(deps.calls.alerts.join('\n')).toContain('no LiFiDiamond resolved')
  })

  it('removes ONLY the parked address when a live facet shares its deploy-log name', async () => {
    const stale = task('SymbiosisFacet', { facetAddress: addr(0x1a) })
    const live = addr(0x2b)
    const deps = makeDeps({
      queued: [stale],
      result: addressResult({
        // The engine resolved by address, so the live v2.0.0 facet is simply absent here.
        removals: [
          { name: undefined, address: stale.facetAddress, selectors: [sel(7)] },
        ],
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(1)
    // Label falls back to the parked task's name; the calldata carries only the stale selectors.
    expect(prep.calls[0]?.calldata).toBe(
      buildDiamondCutRemoveCalldata([
        { name: 'SymbiosisFacet', selectors: [sel(7)] },
      ]) as Hex
    )
    expect(prep.calls[0]?.calldata).not.toContain(live.slice(2))
    expect(prep.claimedTaskKeys).toEqual([stale.taskKey])
  })

  it('cancels a protected facet that was parked in error and alerts loudly', async () => {
    const t = task('DiamondCutFacet')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({
        protectedSkipped: [
          { name: 'DiamondCutFacet', address: t.facetAddress },
        ],
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.cancel).toEqual([t.taskKey])
    expect(prep.calls).toHaveLength(0)
    expect(deps.calls.alerts[0]).toContain('DiamondCutFacet')
    expect(prep.outcome.protectedCancelled).toEqual(['DiamondCutFacet'])
  })

  it('skips a removal whose claim was lost to a concurrent drain (no call if it was the only one)', async () => {
    const t = task('OldFacet')
    const deps = makeDeps({
      queued: [t],
      result: addressResult({ removals: [removal('OldFacet')] }),
      claimFails: new Set([t.taskKey]),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.claim).toEqual([t.taskKey])
    expect(prep.calls).toHaveLength(0)
    expect(prep.outcome.skippedAlreadyClaimed).toEqual(['OldFacet'])
    expect(prep.claimedTaskKeys).toHaveLength(0)
  })

  it('reverts every already-claimed task and rethrows when preparation fails mid-run', async () => {
    const a = task('FacetA')
    const b = task('FacetBB')
    const deps = makeDeps({
      queued: [a, b],
      result: addressResult({
        removals: [removal('FacetA'), removal('FacetBB')],
      }),
      claimThrowsOn: b.taskKey,
    })
    let thrown: Error | undefined
    try {
      await prepareDrainNetwork(NETWORK, PROD, deps)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message).toContain('claim blew up')
    // A was claimed before B threw → A is reverted; the failing claim on B never won.
    expect(deps.calls.revert).toEqual([a.taskKey])
    expect(
      deps.calls.alerts.some((m) => m.includes('preparation failed'))
    ).toBe(true)
  })

  it('handles a mixed batch: removal claimed, gone superseded, protected cancelled', async () => {
    const rem = task('RemFacet')
    const gone = task('GoneFacet')
    const prot = task('OwnershipFacet')
    const deps = makeDeps({
      queued: [rem, gone, prot],
      result: addressResult({
        removals: [removal('RemFacet')],
        notFoundOnChain: [gone.facetAddress],
        protectedSkipped: [
          { name: 'OwnershipFacet', address: prot.facetAddress },
        ],
      }),
    })
    const prep = await prepareDrainNetwork(NETWORK, PROD, deps)

    expect(prep.calls).toHaveLength(1)
    expect(prep.claimedTaskKeys).toEqual([rem.taskKey])
    expect(deps.calls.supersede).toEqual([gone.taskKey])
    expect(deps.calls.cancel).toEqual([prot.taskKey])
    expect(prep.parkedTaskRefs).toEqual([
      { facet: 'RemFacet', prUrl: rem.prUrl },
    ])
  })
})

describe('isDrainEnabled', () => {
  const original = process.env.DRAIN_PARKED_TASKS
  afterEach(() => {
    if (original === undefined) delete process.env.DRAIN_PARKED_TASKS
    else process.env.DRAIN_PARKED_TASKS = original
  })

  it('is true only when DRAIN_PARKED_TASKS === "true"', () => {
    process.env.DRAIN_PARKED_TASKS = 'true'
    expect(isDrainEnabled()).toBe(true)
  })

  it('is false when unset', () => {
    delete process.env.DRAIN_PARKED_TASKS
    expect(isDrainEnabled()).toBe(false)
  })

  it('is false for any other value', () => {
    process.env.DRAIN_PARKED_TASKS = '1'
    expect(isDrainEnabled()).toBe(false)
  })
})

describe('isDirectSendEnv', () => {
  const original = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  afterEach(() => {
    if (original === undefined)
      delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    else process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = original
  })

  it('is true when SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === "true"', () => {
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = 'true'
    expect(isDirectSendEnv('mainnet')).toBe(true)
  })

  it('is true for a testnet network', () => {
    delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    expect(isDirectSendEnv('arbitrumsepolia')).toBe(true)
  })

  it('is false for a production mainnet with the flag unset', () => {
    delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    expect(isDirectSendEnv('mainnet')).toBe(false)
  })
})

describe('isDrainEligible', () => {
  const drainFlag = process.env.DRAIN_PARKED_TASKS
  const directFlag = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  beforeEach(() => {
    process.env.DRAIN_PARKED_TASKS = 'true'
    delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  })
  afterEach(() => {
    if (drainFlag === undefined) delete process.env.DRAIN_PARKED_TASKS
    else process.env.DRAIN_PARKED_TASKS = drainFlag
    if (directFlag === undefined)
      delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    else process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = directFlag
  })

  const opts = (
    over: Partial<IProposeToSafeOptions> = {}
  ): IProposeToSafeOptions => ({
    network: 'mainnet',
    to: '0x',
    calldata: '0x',
    timelock: true,
    ...over,
  })

  it('is true for a flag-on, timelocked, production-mainnet proposal', () => {
    expect(isDrainEligible(opts())).toBe(true)
  })

  it('is false when the flag is off', () => {
    delete process.env.DRAIN_PARKED_TASKS
    expect(isDrainEligible(opts())).toBe(false)
  })

  it('is false for a non-timelock proposal (nothing to batch into)', () => {
    expect(isDrainEligible(opts({ timelock: false }))).toBe(false)
  })

  it('is false on a direct-send / testnet network', () => {
    expect(isDrainEligible(opts({ network: 'arbitrumsepolia' }))).toBe(false)
  })
})

describe('proposeWithDrain', () => {
  const drainFlag = process.env.DRAIN_PARKED_TASKS
  const directFlag = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  beforeEach(() => {
    process.env.DRAIN_PARKED_TASKS = 'true'
    delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  })
  afterEach(() => {
    if (drainFlag === undefined) delete process.env.DRAIN_PARKED_TASKS
    else process.env.DRAIN_PARKED_TASKS = drainFlag
    if (directFlag === undefined)
      delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    else process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = directFlag
  })

  const options: IProposeToSafeOptions = {
    network: NETWORK,
    to: '0x',
    calldata: '0x',
    timelock: true,
  }
  const HASH = '0xdeadbeef' as Hex

  interface IPrimarySpy {
    fn: (
      calls: ITimelockCall[],
      refs?: { facet: string; prUrl: string }[]
    ) => Promise<{ safeTxHash: Hex; stored: boolean }>
    received: {
      calls: ITimelockCall[]
      refs?: { facet: string; prUrl: string }[]
    }[]
  }
  function primarySpy(
    result: { safeTxHash: Hex; stored: boolean } | (() => never) = {
      safeTxHash: HASH,
      stored: true,
    }
  ): IPrimarySpy {
    const received: IPrimarySpy['received'] = []
    return {
      received,
      fn: async (calls, refs) => {
        received.push({ calls, refs })
        if (typeof result === 'function') return result()
        return result
      },
    }
  }

  function makeOpener(deps: IDrainDeps): {
    open: DrainOpener
    openCount: () => number
    closeCount: () => number
  } {
    let opened = 0
    let closed = 0
    return {
      open: async () => {
        opened++
        return {
          close: async () => {
            closed++
          },
          deps,
        }
      },
      openCount: () => opened,
      closeCount: () => closed,
    }
  }

  it('proposes the primary alone (never opens the queue) when the drain is not eligible', async () => {
    delete process.env.DRAIN_PARKED_TASKS
    const spy = primarySpy()
    const opener = makeOpener(makeDeps({ queued: [], result: addressResult() }))
    const result = await proposeWithDrain(options, spy.fn, opener.open)
    expect(opener.openCount()).toBe(0)
    expect(spy.received).toEqual([{ calls: [], refs: undefined }])
    expect(result).toEqual({ safeTxHash: HASH, stored: true })
  })

  it('folds each claimed removal into the primary and links it to the resulting Safe tx hash', async () => {
    const a = task('FacetA')
    const b = task('FacetBB')
    const deps = makeDeps({
      queued: [a, b],
      result: addressResult({
        removals: [removal('FacetA'), removal('FacetBB')],
      }),
    })
    const opener = makeOpener(deps)
    const spy = primarySpy()
    const result = await proposeWithDrain(options, spy.fn, opener.open)

    expect(spy.received).toHaveLength(1)
    expect(spy.received[0]?.calls).toHaveLength(2)
    expect(spy.received[0]?.refs).toEqual([
      { facet: 'FacetA', prUrl: a.prUrl },
      { facet: 'FacetBB', prUrl: b.prUrl },
    ])
    expect(deps.calls.link).toEqual([
      { taskKey: a.taskKey, safeTxHash: HASH },
      { taskKey: b.taskKey, safeTxHash: HASH },
    ])
    expect(deps.calls.revert).toHaveLength(0)
    expect(opener.closeCount()).toBe(1)
    expect(result).toEqual({ safeTxHash: HASH, stored: true })
  })

  it('proposes the primary with no extra calls and links nothing when the queue is empty', async () => {
    const deps = makeDeps({ queued: [], result: addressResult() })
    const opener = makeOpener(deps)
    const spy = primarySpy()
    await proposeWithDrain(options, spy.fn, opener.open)

    expect(spy.received).toEqual([{ calls: [], refs: undefined }])
    expect(deps.calls.link).toHaveLength(0)
    expect(opener.closeCount()).toBe(1)
  })

  it('reverts every claimed task and rethrows when the primary proposal fails', async () => {
    const a = task('FacetA')
    const deps = makeDeps({
      queued: [a],
      result: addressResult({ removals: [removal('FacetA')] }),
    })
    const opener = makeOpener(deps)
    const spy = primarySpy(() => {
      throw new Error('primary sign failed')
    })
    let thrown: Error | undefined
    try {
      await proposeWithDrain(options, spy.fn, opener.open)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message).toBe('primary sign failed')
    expect(deps.calls.link).toHaveLength(0)
    expect(deps.calls.revert).toEqual([a.taskKey])
    expect(opener.closeCount()).toBe(1)
  })

  it('reverts claimed tasks (does not link) when the primary was a duplicate', async () => {
    const a = task('FacetA')
    const deps = makeDeps({
      queued: [a],
      result: addressResult({ removals: [removal('FacetA')] }),
    })
    const opener = makeOpener(deps)
    const spy = primarySpy({ safeTxHash: HASH, stored: false })
    await proposeWithDrain(options, spy.fn, opener.open)

    expect(deps.calls.link).toHaveLength(0)
    expect(deps.calls.revert).toEqual([a.taskKey])
    expect(opener.closeCount()).toBe(1)
  })

  it('never fails the process when linking a claimed task throws — the primary is already stored', async () => {
    const a = task('FacetA')
    const b = task('FacetBB')
    const deps = makeDeps({
      queued: [a, b],
      result: addressResult({
        removals: [removal('FacetA'), removal('FacetBB')],
      }),
    })
    const linkOk = deps.linkProposal
    deps.linkProposal = async (key, hash) => {
      if (key === a.taskKey) throw new Error('mongo link failed')
      return linkOk(key, hash)
    }
    const opener = makeOpener(deps)
    const spy = primarySpy()
    // Must NOT throw even though linking task A fails after the primary was stored.
    const result = await proposeWithDrain(options, spy.fn, opener.open)

    expect(result).toEqual({ safeTxHash: HASH, stored: true })
    // Per-key resilient: B is still linked despite A failing; A is left 'proposed'
    // (NOT reverted — its removal already rode the stored proposal) and alerted.
    expect(deps.calls.link).toEqual([{ taskKey: b.taskKey, safeTxHash: HASH }])
    expect(deps.calls.revert).toHaveLength(0)
    expect(deps.calls.alerts.some((m) => m.includes('could not link'))).toBe(
      true
    )
    expect(opener.closeCount()).toBe(1)
  })

  it('falls back to a primary-only proposal (never breaks the primary) when preparation fails', async () => {
    const deps = makeDeps({ queued: [], result: addressResult() })
    deps.listQueued = async () => {
      throw new Error('mongo down')
    }
    const opener = makeOpener(deps)
    const spy = primarySpy()
    const result = await proposeWithDrain(options, spy.fn, opener.open)

    expect(spy.received).toEqual([{ calls: [], refs: undefined }])
    expect(opener.closeCount()).toBe(1)
    expect(result).toEqual({ safeTxHash: HASH, stored: true })
  })

  it('falls back to a primary-only proposal when the queue cannot be opened', async () => {
    const spy = primarySpy()
    const open: DrainOpener = async () => {
      throw new Error('connect failed')
    }
    const result = await proposeWithDrain(options, spy.fn, open)
    expect(spy.received).toEqual([{ calls: [], refs: undefined }])
    expect(result).toEqual({ safeTxHash: HASH, stored: true })
  })

  it('is reentrancy-guarded: a nested drain during the primary is a no-op', async () => {
    const deps = makeDeps({
      queued: [task('X')],
      result: addressResult({ removals: [removal('X')] }),
    })
    const opener = makeOpener(deps)
    const inner = primarySpy()
    // The primary re-enters proposeWithDrain (as a facet cut inside a cut might):
    // the guard must make the nested call skip the queue entirely.
    const outer: IPrimarySpy = {
      received: [],
      fn: async (calls, refs) => {
        outer.received.push({ calls, refs })
        await proposeWithDrain(options, inner.fn, opener.open)
        return { safeTxHash: HASH, stored: true }
      },
    }
    await proposeWithDrain(options, outer.fn, opener.open)

    // Outer opened once; the nested call returned inner([]) without opening again.
    expect(opener.openCount()).toBe(1)
    expect(inner.received).toEqual([{ calls: [], refs: undefined }])
  })

  it('never fails the process when closing the queue connection throws — the primary is already stored', async () => {
    const a = task('FacetA')
    const deps = makeDeps({
      queued: [a],
      result: addressResult({ removals: [removal('FacetA')] }),
    })
    const open: DrainOpener = async () => ({
      close: async () => {
        throw new Error('connection reset during close')
      },
      deps,
    })
    const spy = primarySpy()
    const result = await proposeWithDrain(options, spy.fn, open)

    expect(result).toEqual({ safeTxHash: HASH, stored: true })
    expect(deps.calls.link).toEqual([{ taskKey: a.taskKey, safeTxHash: HASH }])
  })

  it('surfaces the primary failure even when reverting a claimed task also throws (alerted, not masked)', async () => {
    const a = task('FacetA')
    const deps = makeDeps({
      queued: [a],
      result: addressResult({ removals: [removal('FacetA')] }),
    })
    deps.revert = async () => {
      throw new Error('mongo revert failed')
    }
    const opener = makeOpener(deps)
    const spy = primarySpy(() => {
      throw new Error('primary sign failed')
    })
    let thrown: Error | undefined
    try {
      await proposeWithDrain(options, spy.fn, opener.open)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message).toBe('primary sign failed')
    expect(deps.calls.alerts.some((m) => m.includes('could not revert'))).toBe(
      true
    )
    expect(opener.closeCount()).toBe(1)
  })

  it('never fails the process when post-store bookkeeping throws after linking — the primary is already stored', async () => {
    const a = task('FacetA')
    const deps = makeDeps({
      queued: [a],
      result: addressResult({ removals: [removal('FacetA')] }),
    })
    deps.log = () => {
      throw new Error('log sink blew up')
    }
    const opener = makeOpener(deps)
    const spy = primarySpy()
    const result = await proposeWithDrain(options, spy.fn, opener.open)

    expect(result).toEqual({ safeTxHash: HASH, stored: true })
    expect(deps.calls.link).toEqual([{ taskKey: a.taskKey, safeTxHash: HASH }])
    expect(opener.closeCount()).toBe(1)
  })
})
