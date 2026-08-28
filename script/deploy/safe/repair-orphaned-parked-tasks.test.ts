/**
 * Tests for the orphaned-claim repair pass. Its whole safety property is the
 * orphan predicate: a `proposed` task is reverted to `queued` ONLY when its
 * `safeTxHash` has no document in the proposal store. A claim whose proposal is
 * still alive (possibly another operator's, awaiting signatures) must never be
 * stolen — that would fold the same removal into a second proposal, and the
 * loser reverts the whole batch it rides in at execution.
 *
 * MongoDB is replaced by in-memory fakes covering only the slice used here
 * (find/toArray on the queue, findOne on the proposal store); no real I/O.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection } from 'mongodb'

import { EnvironmentEnum } from '../../common/types'

import { type IParkedTask } from './parked-tasks'
import { repairOrphanedParkedTasks } from './repair-orphaned-parked-tasks'
import { type ISafeTxDocument } from './safe-utils'

// real safeTxHashes are 66-char all-lowercase hex; fixtures match that shape so a
// normalisation regression in the predicate cannot hide behind a toy value
const LIVE_HASH = `0x${'a1b2c3d4'.repeat(8)}`
const GONE_HASH = `0x${'0f1e2d3c'.repeat(8)}`

function makeTask(overrides: Partial<IParkedTask> = {}): IParkedTask {
  return {
    taskKey: 'facet-removal|arbitrum|production|HopFacet',
    kind: 'facet-removal',
    network: 'arbitrum',
    environment: EnvironmentEnum.production,
    facetName: 'HopFacet',
    diamondAddress: '0x1111111111111111111111111111111111111111',
    facetAddress: '0x2222222222222222222222222222222222222222',
    prUrl: 'https://github.com/lifinance/contracts/pull/2219',
    status: 'proposed',
    enqueuer: 'test@li.finance',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    proposedAt: new Date('2026-08-18T00:00:00Z'),
    safeTxHash: GONE_HASH,
    ...overrides,
  }
}

/** Queue fake: records every revertToQueued findOneAndUpdate it is asked for. */
function createQueueFake(
  tasks: IParkedTask[],
  {
    failTransition = false,
    throwOn,
  }: { failTransition?: boolean; throwOn?: string } = {}
): Collection<IParkedTask> & { reverted: string[] } {
  const reverted: string[] = []
  const unwrap = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && '$eq' in (v as object)
      ? (v as { $eq: unknown }).$eq
      : v
  const fake = {
    reverted,
    // a real driver hands back snapshots, so a row that changes afterwards does
    // not change what the caller already read
    find: (filter: Record<string, unknown> = {}) => ({
      toArray: async () =>
        tasks
          .filter((t) =>
            Object.entries(filter).every(
              ([k, v]) =>
                (t as unknown as Record<string, unknown>)[k] === unwrap(v)
            )
          )
          .map((t) => ({ ...t })),
      sort: () => ({ toArray: async () => tasks.map((t) => ({ ...t })) }),
    }),
    // mirrors revertToQueued: filters on taskKey + status (+ safeTxHash when the
    // caller binds it) and applies both the $set and the $unset
    findOneAndUpdate: async (
      filter: Record<string, unknown>,
      update: Record<string, Record<string, unknown>>
    ) => {
      const taskKey = unwrap(filter['taskKey']) as string
      if (throwOn === taskKey) throw new Error('transient Mongo failure')
      if (failTransition) return null
      const expectedHash = filter['safeTxHash']
        ? (unwrap(filter['safeTxHash']) as string)
        : undefined
      const match = tasks.find(
        (t) =>
          t.taskKey === taskKey &&
          t.status === 'proposed' &&
          (expectedHash === undefined || t.safeTxHash === expectedHash)
      )
      if (!match) return null
      Object.assign(match, update['$set'] ?? {})
      for (const field of Object.keys(update['$unset'] ?? {}))
        delete (match as unknown as Record<string, unknown>)[field]
      reverted.push(taskKey)
      return match
    },
  }
  return fake as unknown as Collection<IParkedTask> & { reverted: string[] }
}

function createProposalFake(
  hashes: string[],
  { storeSize, onFindOne }: { storeSize?: number; onFindOne?: () => void } = {}
): Collection<ISafeTxDocument> & { queries: unknown[] } {
  const queries: unknown[] = []
  const fake = {
    queries,
    findOne: async (filter: { safeTxHash?: { $eq: string } }) => {
      queries.push(filter)
      onFindOne?.()
      const hash = filter.safeTxHash?.$eq
      return hashes.includes(hash ?? '')
        ? ({ safeTxHash: hash } as unknown as ISafeTxDocument)
        : null
    },
    // the real store holds thousands of docs of every status, not just the ones
    // this run looks up — default to a plausible size
    countDocuments: async () => storeSize ?? 3000,
  }
  return fake as unknown as Collection<ISafeTxDocument> & { queries: unknown[] }
}

describe('repairOrphanedParkedTasks', () => {
  it('reverts a claim whose proposal is gone', async () => {
    const queue = createQueueFake([makeTask()])
    const result = await repairOrphanedParkedTasks(
      queue,
      createProposalFake([LIVE_HASH]),
      { apply: true }
    )
    expect(result).toEqual({ orphans: 1, repaired: 1, unlinked: 0 })
    expect(queue.reverted).toEqual([
      'facet-removal|arbitrum|production|HopFacet',
    ])
  })

  it('never touches a claim whose proposal still exists', async () => {
    const queue = createQueueFake([makeTask({ safeTxHash: LIVE_HASH })])
    const result = await repairOrphanedParkedTasks(
      queue,
      createProposalFake([LIVE_HASH]),
      { apply: true }
    )
    expect(result).toEqual({ orphans: 0, repaired: 0, unlinked: 0 })
    expect(queue.reverted).toEqual([])
  })

  it('reverts only the orphan in a mixed set', async () => {
    const queue = createQueueFake([
      makeTask({ safeTxHash: LIVE_HASH, taskKey: 'live' }),
      makeTask({ safeTxHash: GONE_HASH, taskKey: 'orphan' }),
    ])
    const result = await repairOrphanedParkedTasks(
      queue,
      createProposalFake([LIVE_HASH]),
      { apply: true }
    )
    expect(result.orphans).toBe(1)
    expect(queue.reverted).toEqual(['orphan'])
  })

  it('reports orphans without mutating anything when apply is false', async () => {
    const queue = createQueueFake([makeTask()])
    const result = await repairOrphanedParkedTasks(
      queue,
      createProposalFake([]),
      { apply: false }
    )
    expect(result).toEqual({ orphans: 1, repaired: 0, unlinked: 0 })
    expect(queue.reverted).toEqual([])
  })

  it('leaves a proposed task with no safeTxHash for manual review', async () => {
    const queue = createQueueFake([makeTask({ safeTxHash: undefined })])
    const proposals = createProposalFake([])
    const result = await repairOrphanedParkedTasks(queue, proposals, {
      apply: true,
    })
    expect(result).toEqual({ orphans: 0, repaired: 0, unlinked: 1 })
    expect(queue.reverted).toEqual([])
    expect(proposals.queries).toEqual([])
  })

  it('keeps repairing after one transition throws', async () => {
    const queue = createQueueFake(
      [
        makeTask({ safeTxHash: LIVE_HASH, taskKey: 'live' }),
        makeTask({ safeTxHash: GONE_HASH, taskKey: 'boom' }),
        makeTask({ safeTxHash: GONE_HASH, taskKey: 'survivor' }),
      ],
      { throwOn: 'boom' }
    )
    const result = await repairOrphanedParkedTasks(
      queue,
      createProposalFake([LIVE_HASH]),
      { apply: true }
    )
    expect(result).toEqual({ orphans: 2, repaired: 1, unlinked: 0 })
    expect(queue.reverted).toEqual(['survivor'])
  })

  it('clears proposedAt and safeTxHash when it reverts', async () => {
    const task = makeTask()
    const queue = createQueueFake([task])
    await repairOrphanedParkedTasks(queue, createProposalFake([LIVE_HASH]), {
      apply: true,
    })
    expect(task.status).toBe('queued')
    expect(task.safeTxHash).toBeUndefined()
    expect(task.proposedAt).toBeUndefined()
  })

  it('leaves a claim re-proposed under a newer hash alone', async () => {
    const task = makeTask()
    const queue = createQueueFake([task])
    const proposals = createProposalFake([], {
      // a concurrent drain re-claims the task after this run judged it an orphan
      onFindOne: () => {
        task.safeTxHash = LIVE_HASH
      },
    })
    const result = await repairOrphanedParkedTasks(queue, proposals, {
      apply: true,
    })
    expect(result).toEqual({ orphans: 1, repaired: 0, unlinked: 0 })
    expect(task.status).toBe('proposed')
    expect(task.safeTxHash).toBe(LIVE_HASH)
  })

  it('refuses to repair against an empty proposal store', async () => {
    const queue = createQueueFake([makeTask()])
    let message = ''
    try {
      await repairOrphanedParkedTasks(
        queue,
        createProposalFake([], { storeSize: 0 }),
        { apply: true }
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/proposal store is empty/)
    expect(queue.reverted).toEqual([])
  })

  it('refuses to repair when every linked claim looks orphaned', async () => {
    const queue = createQueueFake([
      makeTask({ taskKey: 'a' }),
      makeTask({ taskKey: 'b' }),
    ])
    let message = ''
    try {
      await repairOrphanedParkedTasks(queue, createProposalFake([]), {
        apply: true,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/look orphaned/)
    expect(queue.reverted).toEqual([])
  })

  it('counts a lost transition race as unrepaired', async () => {
    // the row flipped out of 'proposed' between the listing and the transition,
    // so revertToQueued matches nothing and returns null
    const queue = createQueueFake([makeTask()], { failTransition: true })
    const result = await repairOrphanedParkedTasks(
      queue,
      createProposalFake([]),
      { apply: true }
    )
    expect(result).toEqual({ orphans: 1, repaired: 0, unlinked: 0 })
  })
})
