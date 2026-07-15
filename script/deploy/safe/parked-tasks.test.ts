/**
 * Tests for the deferred diamond-cleanup queue store layer (parked-tasks.ts).
 *
 * The store persists `IParkedTask` rows in `sc_private.parkedTasks` and enforces
 * a partial unique index on `taskKey` (status ∈ {queued, proposed}) so a facet
 * can only be parked once per network while still open. Every pure helper takes
 * an injected `Collection<IParkedTask>` so the logic is exercised against an
 * in-memory fake that mirrors the partial-unique-index and atomic-flip semantics
 * MongoDB provides — no live cluster / VPN required. Only the thin live adapter
 * `getParkedTasksCollection()` (a `MongoClient` connect + VPN gate) is unit-test
 * exempt, exactly as its sibling `getSafeMongoCollection()` is.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  type Collection,
  type Filter,
  type InsertOneResult,
  type UpdateFilter,
  type WithId,
} from 'mongodb'
import { type Address } from 'viem'

import { EnvironmentEnum } from '../../common/types'

import {
  claimForProposal,
  computeTaskKey,
  enqueueParkedTask,
  ensureParkedTasksIndexes,
  listParkedTasks,
  markCancelled,
  markExecuted,
  markSuperseded,
  revertToQueued,
  type IParkedTask,
  type IParkedTaskInput,
} from './parked-tasks'

const DIAMOND = '0x1111111111111111111111111111111111111111' as Address
const FACET = '0x2222222222222222222222222222222222222222' as Address
const PR_URL = 'https://github.com/lifinance/contracts/pull/2046'

function buildInput(
  overrides: Partial<IParkedTaskInput> = {}
): IParkedTaskInput {
  return {
    kind: 'facet-removal',
    network: 'arbitrum',
    environment: EnvironmentEnum.production,
    facetName: 'GenericSwapFacet',
    diamondAddress: DIAMOND,
    facetAddress: FACET,
    prUrl: PR_URL,
    enqueuer: 'dev@li.finance',
    ...overrides,
  }
}

/**
 * Asserts `promise` rejects with an error whose message matches `match`. Kept as
 * a helper (rather than `expect().rejects`) so the awaited value is a real
 * Promise — `@typescript-eslint/await-thenable` rejects awaiting bun's matcher.
 */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp | string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  if (match instanceof RegExp) expect(error?.message).toMatch(match)
  else expect(error?.message).toContain(match)
}

class FakeDuplicateKeyError extends Error {
  public code = 11000
  public constructor() {
    super(
      'E11000 duplicate key error collection: sc_private.parkedTasks index: unique_open_task_key'
    )
  }
}

/** True when `value` matches a Mongo leaf filter (`$eq` / `$in` / literal). */
function matchesLeaf(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object') {
    const c = cond as { $eq?: unknown; $in?: unknown[] }
    if ('$eq' in c) return value === c.$eq
    if ('$in' in c) return (c.$in ?? []).includes(value)
  }
  return value === cond
}

function matchesFilter(row: IParkedTask, filter: Filter<IParkedTask>): boolean {
  const record = row as unknown as Record<string, unknown>
  return Object.entries(filter).every(([key, cond]) =>
    matchesLeaf(record[key], cond)
  )
}

interface IFakeOptions {
  createIndexError?: Error
}

type IFakeCollection = Collection<IParkedTask> & {
  rows: IParkedTask[]
  createIndexCalls: { spec: unknown; options: unknown }[]
}

/**
 * In-memory stand-in for the `parkedTasks` collection. Replicates the partial
 * unique index (an insert whose `taskKey` collides with an existing
 * queued/proposed row throws code 11000), `find().toArray()`, the atomic
 * `findOneAndUpdate` used by the status transitions, and `createIndex`.
 */
function createFakeCollection(
  initial: IParkedTask[] = [],
  options: IFakeOptions = {}
): IFakeCollection {
  const rows: IParkedTask[] = initial.map((r) => ({ ...r }))
  const createIndexCalls: { spec: unknown; options: unknown }[] = []
  const OPEN = ['queued', 'proposed']
  const api = {
    rows,
    createIndexCalls,
    async insertOne(doc: IParkedTask): Promise<InsertOneResult> {
      const duplicate = rows.some(
        (r) =>
          r.taskKey === doc.taskKey &&
          OPEN.includes(r.status) &&
          OPEN.includes(doc.status)
      )
      if (duplicate) throw new FakeDuplicateKeyError()
      rows.push({ ...doc })
      return {
        acknowledged: true,
        insertedId: rows.length,
      } as unknown as InsertOneResult
    },
    find(filter: Filter<IParkedTask>) {
      return {
        async toArray(): Promise<WithId<IParkedTask>[]> {
          return rows.filter((r) =>
            matchesFilter(r, filter)
          ) as WithId<IParkedTask>[]
        },
      }
    },
    async findOneAndUpdate(
      filter: Filter<IParkedTask>,
      update: UpdateFilter<IParkedTask>,
      opts?: { returnDocument?: 'before' | 'after' }
    ): Promise<WithId<IParkedTask> | null> {
      const row = rows.find((r) => matchesFilter(r, filter))
      if (!row) return null
      // Snapshot BEFORE mutating so the driver-default 'before' is honored — this
      // is what forces production to pass returnDocument:'after' for the
      // post-update assertions to hold.
      const before = { ...row } as WithId<IParkedTask>
      Object.assign(row, update.$set ?? {})
      const record = row as unknown as Record<string, unknown>
      for (const field of Object.keys(update.$unset ?? {})) delete record[field]
      return opts?.returnDocument === 'after'
        ? (row as WithId<IParkedTask>)
        : before
    },
    async createIndex(spec: unknown, opts: unknown): Promise<string> {
      createIndexCalls.push({ spec, options: opts })
      if (options.createIndexError) throw options.createIndexError
      return (opts as { name: string }).name
    },
  }
  return api as unknown as IFakeCollection
}

describe('computeTaskKey', () => {
  it('joins kind|network|environment|facetName', () => {
    expect(
      computeTaskKey(
        'facet-removal',
        'arbitrum',
        EnvironmentEnum.production,
        'GenericSwapFacet'
      )
    ).toBe('facet-removal|arbitrum|production|GenericSwapFacet')
  })

  it('lowercases only the network segment', () => {
    expect(
      computeTaskKey(
        'facet-removal',
        'Arbitrum',
        EnvironmentEnum.production,
        'GenericSwapFacet'
      )
    ).toBe('facet-removal|arbitrum|production|GenericSwapFacet')
  })
})

describe('enqueueParkedTask', () => {
  it('inserts a queued task and stamps taskKey/status/createdAt', async () => {
    const coll = createFakeCollection()
    const result = await enqueueParkedTask(coll, buildInput())
    expect(result).not.toBeNull()
    expect(coll.rows).toHaveLength(1)
    const row = coll.rows[0]
    expect(row?.taskKey).toBe(
      'facet-removal|arbitrum|production|GenericSwapFacet'
    )
    expect(row?.status).toBe('queued')
    expect(row?.createdAt).toBeInstanceOf(Date)
    expect(row?.prUrl).toBe(PR_URL)
    expect(row?.network).toBe('arbitrum')
  })

  it('lowercases the network before storing', async () => {
    const coll = createFakeCollection()
    await enqueueParkedTask(coll, buildInput({ network: 'Arbitrum' }))
    expect(coll.rows[0]?.network).toBe('arbitrum')
    expect(coll.rows[0]?.taskKey).toBe(
      'facet-removal|arbitrum|production|GenericSwapFacet'
    )
  })

  it('returns null on a duplicate open task (E11000), without throwing', async () => {
    const coll = createFakeCollection()
    await enqueueParkedTask(coll, buildInput())
    const second = await enqueueParkedTask(coll, buildInput())
    expect(second).toBeNull()
    expect(coll.rows).toHaveLength(1)
  })

  it('rethrows a non-duplicate insert error', async () => {
    const coll = createFakeCollection()
    coll.insertOne = async () => {
      throw new Error('connection reset')
    }
    await expectRejects(
      enqueueParkedTask(coll, buildInput()),
      'connection reset'
    )
  })

  it('throws when prUrl is missing', async () => {
    const coll = createFakeCollection()
    await expectRejects(
      enqueueParkedTask(
        coll,
        buildInput({ prUrl: undefined as unknown as string })
      ),
      /prUrl is required/
    )
    expect(coll.rows).toHaveLength(0)
  })

  it('throws when prUrl is blank', async () => {
    const coll = createFakeCollection()
    await expectRejects(
      enqueueParkedTask(coll, buildInput({ prUrl: '   ' })),
      /prUrl is required/
    )
    expect(coll.rows).toHaveLength(0)
  })

  it('throws when facetName is blank', async () => {
    const coll = createFakeCollection()
    await expectRejects(
      enqueueParkedTask(coll, buildInput({ facetName: '  ' })),
      /facetName is required/
    )
    expect(coll.rows).toHaveLength(0)
  })

  it('trims network, facetName and prUrl before storing/keying', async () => {
    const coll = createFakeCollection()
    await enqueueParkedTask(
      coll,
      buildInput({
        network: '  Arbitrum ',
        facetName: '  GenericSwapFacet  ',
        prUrl: `  ${PR_URL}  `,
      })
    )
    const row = coll.rows[0]
    expect(row?.network).toBe('arbitrum')
    expect(row?.facetName).toBe('GenericSwapFacet')
    expect(row?.prUrl).toBe(PR_URL)
    expect(row?.taskKey).toBe(
      'facet-removal|arbitrum|production|GenericSwapFacet'
    )
  })
})

describe('listParkedTasks', () => {
  function seed(): IFakeCollection {
    return createFakeCollection([
      {
        taskKey: 'facet-removal|arbitrum|production|A',
        kind: 'facet-removal',
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facetName: 'A',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: 'https://github.com/lifinance/contracts/pull/1',
        status: 'queued',
        enqueuer: 'dev@li.finance',
        createdAt: new Date(),
      },
      {
        taskKey: 'facet-removal|base|production|B',
        kind: 'facet-removal',
        network: 'base',
        environment: EnvironmentEnum.production,
        facetName: 'B',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: 'https://github.com/lifinance/contracts/pull/2',
        status: 'proposed',
        enqueuer: 'dev@li.finance',
        createdAt: new Date(),
      },
      {
        taskKey: 'facet-removal|base|production|C',
        kind: 'facet-removal',
        network: 'base',
        environment: EnvironmentEnum.production,
        facetName: 'C',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: 'https://github.com/lifinance/contracts/pull/1',
        status: 'executed',
        enqueuer: 'dev@li.finance',
        createdAt: new Date(),
      },
    ])
  }

  it('returns all tasks with no filter', async () => {
    const tasks = await listParkedTasks(seed(), {})
    expect(tasks).toHaveLength(3)
  })

  it('filters by network (lowercased)', async () => {
    const tasks = await listParkedTasks(seed(), { network: 'Base' })
    expect(tasks.map((t) => t.facetName).sort()).toEqual(['B', 'C'])
  })

  it('filters by status', async () => {
    const tasks = await listParkedTasks(seed(), { status: 'queued' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.facetName).toBe('A')
  })

  it('filters by prUrl', async () => {
    const tasks = await listParkedTasks(seed(), {
      prUrl: 'https://github.com/lifinance/contracts/pull/1',
    })
    expect(tasks.map((t) => t.facetName).sort()).toEqual(['A', 'C'])
  })

  it('combines network + status filters', async () => {
    const tasks = await listParkedTasks(seed(), {
      network: 'base',
      status: 'proposed',
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.facetName).toBe('B')
  })
})

describe('claimForProposal', () => {
  function seedOne(status: IParkedTask['status']): IFakeCollection {
    return createFakeCollection([
      {
        taskKey: 'facet-removal|arbitrum|production|A',
        kind: 'facet-removal',
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facetName: 'A',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: PR_URL,
        status,
        enqueuer: 'dev@li.finance',
        createdAt: new Date(),
      },
    ])
  }

  it('atomically flips a queued task to proposed and stamps proposedAt', async () => {
    const coll = seedOne('queued')
    const claimed = await claimForProposal(
      coll,
      'facet-removal|arbitrum|production|A'
    )
    expect(claimed).not.toBeNull()
    expect(claimed?.status).toBe('proposed')
    expect(claimed?.proposedAt).toBeInstanceOf(Date)
    expect(coll.rows[0]?.status).toBe('proposed')
  })

  it('returns null when the task is already claimed (not queued)', async () => {
    const coll = seedOne('proposed')
    const claimed = await claimForProposal(
      coll,
      'facet-removal|arbitrum|production|A'
    )
    expect(claimed).toBeNull()
    expect(coll.rows[0]?.status).toBe('proposed')
  })

  it('returns null for an unknown taskKey', async () => {
    const coll = seedOne('queued')
    expect(await claimForProposal(coll, 'nope')).toBeNull()
  })
})

describe('status transitions', () => {
  const KEY = 'facet-removal|arbitrum|production|A'
  function seedOne(status: IParkedTask['status']): IFakeCollection {
    return createFakeCollection([
      {
        taskKey: KEY,
        kind: 'facet-removal',
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facetName: 'A',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: PR_URL,
        status,
        enqueuer: 'dev@li.finance',
        createdAt: new Date(),
        proposedAt: new Date(),
        safeTxHash: '0xabc',
      },
    ])
  }

  it('markExecuted flips proposed→executed and sets resolvedAt', async () => {
    const coll = seedOne('proposed')
    const doc = await markExecuted(coll, KEY)
    expect(doc?.status).toBe('executed')
    expect(doc?.resolvedAt).toBeInstanceOf(Date)
  })

  it('markExecuted is a no-op (null) on a queued task', async () => {
    const coll = seedOne('queued')
    expect(await markExecuted(coll, KEY)).toBeNull()
    expect(coll.rows[0]?.status).toBe('queued')
  })

  it('markSuperseded flips a queued task to superseded', async () => {
    const coll = seedOne('queued')
    const doc = await markSuperseded(coll, KEY)
    expect(doc?.status).toBe('superseded')
    expect(doc?.resolvedAt).toBeInstanceOf(Date)
  })

  it('markSuperseded flips a proposed task to superseded', async () => {
    const coll = seedOne('proposed')
    expect((await markSuperseded(coll, KEY))?.status).toBe('superseded')
  })

  it('markSuperseded is a no-op (null) on an executed task', async () => {
    const coll = seedOne('executed')
    expect(await markSuperseded(coll, KEY)).toBeNull()
  })

  it('markCancelled flips a queued task to cancelled', async () => {
    const coll = seedOne('queued')
    const doc = await markCancelled(coll, KEY)
    expect(doc?.status).toBe('cancelled')
    expect(doc?.resolvedAt).toBeInstanceOf(Date)
  })

  it('markCancelled is a no-op (null) on a cancelled task', async () => {
    const coll = seedOne('cancelled')
    expect(await markCancelled(coll, KEY)).toBeNull()
  })

  it('markCancelled is a no-op (null) on a proposed task (avoids orphaning its proposal)', async () => {
    const coll = seedOne('proposed')
    expect(await markCancelled(coll, KEY)).toBeNull()
    expect(coll.rows[0]?.status).toBe('proposed')
  })

  it('revertToQueued flips proposed→queued and clears proposedAt+safeTxHash', async () => {
    const coll = seedOne('proposed')
    const doc = await revertToQueued(coll, KEY)
    expect(doc?.status).toBe('queued')
    expect(doc?.proposedAt).toBeUndefined()
    expect(doc?.safeTxHash).toBeUndefined()
  })

  it('revertToQueued is a no-op (null) on a queued task', async () => {
    const coll = seedOne('queued')
    expect(await revertToQueued(coll, KEY)).toBeNull()
  })
})

describe('ensureParkedTasksIndexes', () => {
  it('creates the partial unique index on taskKey for open statuses', async () => {
    const coll = createFakeCollection()
    await ensureParkedTasksIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(1)
    const call = coll.createIndexCalls[0]
    expect(call?.spec).toEqual({ taskKey: 1 })
    expect(call?.options).toEqual({
      unique: true,
      partialFilterExpression: { status: { $in: ['queued', 'proposed'] } },
      name: 'unique_open_task_key',
    })
  })

  it('surfaces an index-options conflict (code 85) as a clear error', async () => {
    const err = Object.assign(new Error('conflict'), { code: 85 })
    const coll = createFakeCollection([], { createIndexError: err })
    await expectRejects(ensureParkedTasksIndexes(coll), /Index conflict/)
  })

  it('surfaces an index-keyspec conflict (code 86) as a clear error', async () => {
    const err = Object.assign(new Error('conflict'), { code: 86 })
    const coll = createFakeCollection([], { createIndexError: err })
    await expectRejects(ensureParkedTasksIndexes(coll), /Index conflict/)
  })

  it('rethrows any other createIndex error unchanged', async () => {
    const err = Object.assign(new Error('network down'), { code: 6 })
    const coll = createFakeCollection([], { createIndexError: err })
    await expectRejects(ensureParkedTasksIndexes(coll), 'network down')
  })
})
