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

const LIVE_HASH = '0xlive'
const GONE_HASH = '0xgone'

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
  { failTransition = false }: { failTransition?: boolean } = {}
): Collection<IParkedTask> & { reverted: string[] } {
  const reverted: string[] = []
  const unwrap = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && '$eq' in (v as object)
      ? (v as { $eq: unknown }).$eq
      : v
  const fake = {
    reverted,
    find: (filter: Record<string, unknown> = {}) => ({
      toArray: async () =>
        tasks.filter((t) =>
          Object.entries(filter).every(
            ([k, v]) =>
              (t as unknown as Record<string, unknown>)[k] === unwrap(v)
          )
        ),
      sort: () => ({ toArray: async () => tasks }),
    }),
    findOneAndUpdate: async (filter: Record<string, unknown>) => {
      if (failTransition) return null
      const taskKey = unwrap(filter['taskKey']) as string
      const match = tasks.find(
        (t) => t.taskKey === taskKey && t.status === 'proposed'
      )
      if (!match) return null
      match.status = 'queued'
      reverted.push(taskKey)
      return match
    },
  }
  return fake as unknown as Collection<IParkedTask> & { reverted: string[] }
}

function createProposalFake(
  hashes: string[]
): Collection<ISafeTxDocument> & { queries: unknown[] } {
  const queries: unknown[] = []
  const fake = {
    queries,
    findOne: async (filter: { safeTxHash?: { $eq: string } }) => {
      queries.push(filter)
      const hash = filter.safeTxHash?.$eq
      return hashes.includes(hash ?? '')
        ? ({ safeTxHash: hash } as unknown as ISafeTxDocument)
        : null
    },
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
