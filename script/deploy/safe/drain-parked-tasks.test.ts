/**
 * Tests for the deferred diamond-cleanup drain (drain-parked-tasks.ts).
 *
 * The pure `drainNetwork(...)` orchestration is exercised against fully injected
 * dependencies (queue reads/transitions, the removal engine, the proposal mint,
 * and alert/log sinks) — no Mongo, no chain, no Safe client. Only the live
 * adapter (`drainParkedTasks`'s Mongo/Safe wiring) is unit-test exempt, mirroring
 * the store layer's `getParkedTasksCollection()` carve-out. The env gates
 * (`isDrainEnabled` / `isDirectSendEnv`) and `drainParkedTasks`' early-returns are
 * covered directly so the flag-off / direct-send / reentrancy guards are proven.
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
import { type Address } from 'viem'

import { EnvironmentEnum } from '../../common/types'

import {
  type IFacetRemoval,
  type INamedRemovalResult,
} from './diamondRemovalDiff'
import {
  drainNetwork,
  drainParkedTasks,
  isDirectSendEnv,
  isDrainEnabled,
  runDrain,
  type IDrainDeps,
} from './drain-parked-tasks'
import { type IParkedTask } from './parked-tasks'

const NETWORK = 'arbitrum'
const PROD = EnvironmentEnum.production
const addr = (n: number): Address =>
  `0x${n.toString(16).padStart(40, '0')}` as Address
const sel = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(8, '0')}` as `0x${string}`

function task(
  facetName: string,
  overrides: Partial<IParkedTask> = {}
): WithId<IParkedTask> {
  return {
    taskKey: `facet-removal|${NETWORK}|production|${facetName}`,
    kind: 'facet-removal',
    network: NETWORK,
    environment: PROD,
    facetName,
    diamondAddress: addr(0xd),
    facetAddress: addr(0xf),
    prUrl: `https://github.com/lifinance/contracts/pull/${facetName.length}`,
    status: 'queued',
    enqueuer: 'dev@li.finance',
    createdAt: new Date(),
    ...overrides,
  } as WithId<IParkedTask>
}

function removal(name: string, selectors = [sel(1)]): IFacetRemoval {
  return { name, address: addr(0xf), selectors }
}

function namedResult(
  over: Partial<INamedRemovalResult> = {}
): INamedRemovalResult {
  return {
    network: NETWORK,
    environment: PROD,
    diamondAddress: addr(0xd),
    removals: [],
    notFoundOnChain: [],
    protectedSkipped: [],
    prunedButRouted: [],
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
    mint: {
      removals: IFacetRemoval[]
      parkedTaskRefs: { facet: string; prUrl: string }[]
    }[]
    alerts: string[]
    logs: string[]
  }
}

function makeDeps(opts: {
  queued: WithId<IParkedTask>[]
  result: INamedRemovalResult
  claimFails?: Set<string>
  mintThrows?: Error
  mintHash?: string
}): ISpyDeps {
  const calls: ISpyDeps['calls'] = {
    claim: [],
    supersede: [],
    cancel: [],
    revert: [],
    link: [],
    mint: [],
    alerts: [],
    logs: [],
  }
  const byKey = new Map(opts.queued.map((t) => [t.taskKey, t]))
  const deps: ISpyDeps = {
    calls,
    listQueued: async () => opts.queued,
    computeRemovals: async () => opts.result,
    claim: async (taskKey) => {
      calls.claim.push(taskKey)
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
    mint: async ({ removals, parkedTaskRefs }) => {
      calls.mint.push({ removals, parkedTaskRefs })
      if (opts.mintThrows) throw opts.mintThrows
      return opts.mintHash ?? '0xsafehash'
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

describe('drainNetwork', () => {
  it('no-ops when nothing is queued (no engine, no mint)', async () => {
    let computeCalled = false
    const deps = makeDeps({ queued: [], result: namedResult() })
    deps.computeRemovals = async () => {
      computeCalled = true
      return namedResult()
    }
    const outcome = await drainNetwork(NETWORK, PROD, deps)
    expect(computeCalled).toBe(false)
    expect(deps.calls.mint).toHaveLength(0)
    expect(outcome.proposed).toHaveLength(0)
  })

  it('claims a queued removal, mints one proposal carrying its origin PR, and links it', async () => {
    const t = task('OldFacet')
    const deps = makeDeps({
      queued: [t],
      result: namedResult({ removals: [removal('OldFacet')] }),
    })
    const outcome = await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.claim).toEqual([t.taskKey])
    expect(deps.calls.mint).toHaveLength(1)
    expect(deps.calls.mint[0]?.removals).toEqual([removal('OldFacet')])
    expect(deps.calls.mint[0]?.parkedTaskRefs).toEqual([
      { facet: 'OldFacet', prUrl: t.prUrl },
    ])
    expect(deps.calls.link).toEqual([
      { taskKey: t.taskKey, safeTxHash: '0xsafehash' },
    ])
    expect(outcome.safeTxHash).toBe('0xsafehash')
    expect(outcome.proposed).toEqual([{ facet: 'OldFacet', prUrl: t.prUrl }])
  })

  it('batches multiple queued facets from different PRs into ONE proposal with all origin PRs', async () => {
    const a = task('FacetA', { prUrl: 'https://gh/pull/2046' })
    const b = task('FacetBB', { prUrl: 'https://gh/pull/2048' })
    const deps = makeDeps({
      queued: [a, b],
      result: namedResult({
        removals: [removal('FacetA'), removal('FacetBB')],
      }),
    })
    await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.mint).toHaveLength(1)
    expect(deps.calls.mint[0]?.removals).toHaveLength(2)
    expect(deps.calls.mint[0]?.parkedTaskRefs).toEqual([
      { facet: 'FacetA', prUrl: 'https://gh/pull/2046' },
      { facet: 'FacetBB', prUrl: 'https://gh/pull/2048' },
    ])
    expect(deps.calls.link).toHaveLength(2)
  })

  it('supersedes a task whose facet is already gone on-chain (not minted)', async () => {
    const t = task('GoneFacet')
    const deps = makeDeps({
      queued: [t],
      result: namedResult({ notFoundOnChain: ['GoneFacet'] }),
    })
    const outcome = await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.supersede).toEqual([t.taskKey])
    expect(deps.calls.mint).toHaveLength(0)
    expect(outcome.superseded).toEqual(['GoneFacet'])
  })

  it('keeps a pruned-but-routed task queued and alerts (never supersedes a live facet)', async () => {
    const t = task('LiveFacet')
    const deps = makeDeps({
      queued: [t],
      result: namedResult({
        prunedButRouted: [{ name: 'LiveFacet', address: t.facetAddress }],
      }),
    })
    const outcome = await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.supersede).toHaveLength(0)
    expect(deps.calls.claim).toHaveLength(0)
    expect(deps.calls.mint).toHaveLength(0)
    expect(deps.calls.alerts).toHaveLength(1)
    expect(deps.calls.alerts[0]).toContain('LiveFacet')
    expect(outcome.prunedButRouted).toEqual([
      { facet: 'LiveFacet', prUrl: t.prUrl },
    ])
  })

  it('cancels a protected facet that was parked in error and alerts loudly', async () => {
    const t = task('DiamondCutFacet')
    const deps = makeDeps({
      queued: [t],
      result: namedResult({ protectedSkipped: ['DiamondCutFacet'] }),
    })
    const outcome = await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.cancel).toEqual([t.taskKey])
    expect(deps.calls.mint).toHaveLength(0)
    expect(deps.calls.alerts[0]).toContain('DiamondCutFacet')
    expect(outcome.protectedCancelled).toEqual(['DiamondCutFacet'])
  })

  it('skips a removal whose claim was lost to a concurrent drain (no mint if it was the only one)', async () => {
    const t = task('OldFacet')
    const deps = makeDeps({
      queued: [t],
      result: namedResult({ removals: [removal('OldFacet')] }),
      claimFails: new Set([t.taskKey]),
    })
    const outcome = await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.claim).toEqual([t.taskKey])
    expect(deps.calls.mint).toHaveLength(0)
    expect(outcome.skippedAlreadyClaimed).toEqual(['OldFacet'])
    expect(outcome.proposed).toHaveLength(0)
  })

  it('reverts every claimed task and rethrows when the mint fails', async () => {
    const a = task('FacetA')
    const b = task('FacetBB')
    const deps = makeDeps({
      queued: [a, b],
      result: namedResult({
        removals: [removal('FacetA'), removal('FacetBB')],
      }),
      mintThrows: new Error('safe mint failed'),
    })
    let thrown: Error | undefined
    try {
      await drainNetwork(NETWORK, PROD, deps)
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message).toBe('safe mint failed')
    expect(deps.calls.revert).toEqual([a.taskKey, b.taskKey])
    expect(deps.calls.link).toHaveLength(0)
    expect(deps.calls.alerts.some((m) => m.includes('mint'))).toBe(true)
  })

  it('handles a mixed batch: removal minted, gone superseded, protected cancelled, pruned alerted', async () => {
    const rem = task('RemFacet')
    const gone = task('GoneFacet')
    const prot = task('OwnershipFacet')
    const pruned = task('PrunedFacet')
    const deps = makeDeps({
      queued: [rem, gone, prot, pruned],
      result: namedResult({
        removals: [removal('RemFacet')],
        notFoundOnChain: ['GoneFacet'],
        protectedSkipped: ['OwnershipFacet'],
        prunedButRouted: [
          { name: 'PrunedFacet', address: pruned.facetAddress },
        ],
      }),
    })
    const outcome = await drainNetwork(NETWORK, PROD, deps)

    expect(deps.calls.mint).toHaveLength(1)
    expect(deps.calls.mint[0]?.removals).toEqual([removal('RemFacet')])
    expect(deps.calls.supersede).toEqual([gone.taskKey])
    expect(deps.calls.cancel).toEqual([prot.taskKey])
    expect(outcome.prunedButRouted).toHaveLength(1)
    expect(outcome.proposed).toEqual([{ facet: 'RemFacet', prUrl: rem.prUrl }])
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

describe('drainParkedTasks (env gates)', () => {
  const drainFlag = process.env.DRAIN_PARKED_TASKS
  const directFlag = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  beforeEach(() => {
    delete process.env.DRAIN_PARKED_TASKS
    delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  })
  afterEach(() => {
    if (drainFlag === undefined) delete process.env.DRAIN_PARKED_TASKS
    else process.env.DRAIN_PARKED_TASKS = drainFlag
    if (directFlag === undefined)
      delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    else process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = directFlag
  })

  it('no-ops (never touches Mongo) when the flag is off', async () => {
    // No MONGODB_URI needed: it must return before opening the queue.
    expect(
      await drainParkedTasks({ network: 'mainnet', to: '0x', calldata: '0x' })
    ).toBeUndefined()
  })

  it('no-ops on a direct-send environment even with the flag on', async () => {
    process.env.DRAIN_PARKED_TASKS = 'true'
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = 'true'
    expect(
      await drainParkedTasks({ network: 'mainnet', to: '0x', calldata: '0x' })
    ).toBeUndefined()
  })

  it('no-ops on a testnet network even with the flag on', async () => {
    process.env.DRAIN_PARKED_TASKS = 'true'
    expect(
      await drainParkedTasks({
        network: 'arbitrumsepolia',
        to: '0x',
        calldata: '0x',
      })
    ).toBeUndefined()
  })
})

describe('runDrain (gate → open → drain → close)', () => {
  const opts = { network: NETWORK, to: '0x', calldata: '0x' as const }
  const drainFlag = process.env.DRAIN_PARKED_TASKS
  const directFlag = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  beforeEach(() => {
    delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    process.env.DRAIN_PARKED_TASKS = 'true'
  })
  afterEach(() => {
    if (drainFlag === undefined) delete process.env.DRAIN_PARKED_TASKS
    else process.env.DRAIN_PARKED_TASKS = drainFlag
    if (directFlag === undefined)
      delete process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
    else process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND = directFlag
  })

  it('does not even open the queue when the flag is off', async () => {
    delete process.env.DRAIN_PARKED_TASKS
    let opened = false
    await runDrain(opts, PROD, async () => {
      opened = true
      return {
        close: async () => {},
        deps: makeDeps({ queued: [], result: namedResult() }),
      }
    })
    expect(opened).toBe(false)
  })

  it('always closes the connection on success', async () => {
    let closed = false
    await runDrain(opts, PROD, async () => ({
      close: async () => {
        closed = true
      },
      deps: makeDeps({ queued: [], result: namedResult() }),
    }))
    expect(closed).toBe(true)
  })

  it('closes the connection even when the drain throws, and rethrows', async () => {
    let closed = false
    const deps = makeDeps({
      queued: [task('X')],
      result: namedResult({ removals: [removal('X')] }),
      mintThrows: new Error('boom'),
    })
    let thrown: Error | undefined
    try {
      await runDrain(opts, PROD, async () => ({
        close: async () => {
          closed = true
        },
        deps,
      }))
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message).toBe('boom')
    expect(closed).toBe(true)
    expect(deps.calls.revert).toEqual([task('X').taskKey])
  })

  it('is reentrancy-guarded: a nested drain during the mint is a no-op', async () => {
    let openCount = 0
    const open = async () => {
      openCount++
      const deps = makeDeps({
        queued: [task('X')],
        result: namedResult({ removals: [removal('X')] }),
      })
      // Simulate the mint (or anything it calls) re-entering the drain: the guard
      // must make the nested call a no-op so it never opens/mints again.
      deps.mint = async () => {
        await runDrain(opts, PROD, open)
        return '0xhash'
      }
      return { close: async () => {}, deps }
    }
    await runDrain(opts, PROD, open)
    expect(openCount).toBe(1)
  })
})
