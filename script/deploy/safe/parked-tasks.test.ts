/**
 * Tests for the deferred diamond-cleanup queue store layer (parked-tasks.ts).
 *
 * The store persists `IParkedTask` rows in `deferred-cleanup.parkedTasks` and
 * enforces a partial unique index on `taskKey` (status ∈ {queued, proposed}) so a
 * facet can only be parked once per network while still open. Every pure helper
 * takes an injected `Collection<IParkedTask>` so the logic is exercised against an
 * in-memory fake that mirrors the partial-unique-index and atomic-flip semantics
 * MongoDB provides — no live cluster required. Only the thin live adapter
 * `getParkedTasksCollection()` (a `MongoClient` connect) is unit-test exempt,
 * exactly as its sibling `getTimelockQueueCollection()` is.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  ObjectId,
  type Collection,
  type Filter,
  type InsertOneResult,
  type UpdateFilter,
  type WithId,
} from 'mongodb'
import { getAddress, type Address } from 'viem'

import { EnvironmentEnum } from '../../common/types'

import {
  claimForProposal,
  computeTaskKey,
  enqueueParkedTask,
  ensureParkedTasksIndexes,
  listParkedTasks,
  listParkedTasksBySafeTxHash,
  markCancelled,
  markExecuted,
  markSuperseded,
  reopenResolvedTask,
  revertToQueued,
  setSafeTxHash,
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
      'E11000 duplicate key error collection: deferred-cleanup.parkedTasks index: unique_open_task_key'
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

/** `_id` of the fake collection row at `index` — the reopen transition addresses by id. */
function idOf(coll: IFakeCollection, index: number): ObjectId {
  const id = (coll.rows[index] as WithId<IParkedTask> | undefined)?._id
  if (!id) throw new Error(`fake collection has no row at index ${index}`)
  return id
}

function matchesFilter(row: IParkedTask, filter: Filter<IParkedTask>): boolean {
  const record = row as unknown as Record<string, unknown>
  return Object.entries(filter).every(([key, cond]) =>
    matchesLeaf(record[key], cond)
  )
}

interface IFakeOptions {
  createIndexError?: Error
  /** Index descriptors `listIndexes().toArray()` returns (default: none). */
  existingIndexes?: { name: string }[]
  /** When set, `listIndexes().toArray()` rejects with this error. */
  listIndexesError?: Error
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
      const matched = () =>
        rows.filter((r) => matchesFilter(r, filter)) as WithId<IParkedTask>[]
      return {
        sort(spec: Record<string, 1 | -1>) {
          return {
            async toArray(): Promise<WithId<IParkedTask>[]> {
              const out = matched()
              const entries = Object.entries(spec)
              const first = entries[0]
              if (!first) return out
              const [field, dir] = first
              return out.sort((a, b) => {
                const av = (a as unknown as Record<string, unknown>)[field]
                const bv = (b as unknown as Record<string, unknown>)[field]
                if (av === bv) return 0
                if (av === null || av === undefined) return -1 * dir
                if (bv === null || bv === undefined) return 1 * dir
                return (av < bv ? -1 : 1) * dir
              })
            },
          }
        },
        async toArray(): Promise<WithId<IParkedTask>[]> {
          return matched()
        },
      }
    },
    async findOne(
      filter: Filter<IParkedTask>
    ): Promise<WithId<IParkedTask> | null> {
      return (
        (rows.find((r) => matchesFilter(r, filter)) as
          | WithId<IParkedTask>
          | undefined) ?? null
      )
    },
    async findOneAndUpdate(
      filter: Filter<IParkedTask>,
      update: UpdateFilter<IParkedTask>,
      opts?: { returnDocument?: 'before' | 'after' }
    ): Promise<WithId<IParkedTask> | null> {
      const row = rows.find((r) => matchesFilter(r, filter))
      if (!row) return null
      // The partial unique index applies to updates too, not only inserts: moving a
      // terminal row back into an open status collides with an existing open row
      // for the taskKey the update WRITES (reopenResolvedTask recomputes it).
      const set = update.$set as Partial<IParkedTask> | undefined
      const nextStatus = set?.status
      const nextKey = set?.taskKey ?? row.taskKey
      if (
        nextStatus &&
        OPEN.includes(nextStatus) &&
        !OPEN.includes(row.status) &&
        rows.some(
          (r) => r !== row && r.taskKey === nextKey && OPEN.includes(r.status)
        )
      )
        throw new FakeDuplicateKeyError()
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
    listIndexes() {
      return {
        async toArray(): Promise<{ name: string }[]> {
          if (options.listIndexesError) throw options.listIndexesError
          return options.existingIndexes ?? []
        },
      }
    },
  }
  return api as unknown as IFakeCollection
}

describe('computeTaskKey', () => {
  it('joins kind|network|environment|facetAddress', () => {
    expect(
      computeTaskKey(
        'facet-removal',
        'arbitrum',
        EnvironmentEnum.production,
        FACET
      )
    ).toBe(`facet-removal|arbitrum|production|${FACET.toLowerCase()}`)
  })

  it('lowercases the network and an EVM address', () => {
    expect(
      computeTaskKey(
        'facet-removal',
        'Arbitrum',
        EnvironmentEnum.production,
        ('0x' + FACET.slice(2).toUpperCase()) as Address
      )
    ).toBe(`facet-removal|arbitrum|production|${FACET.toLowerCase()}`)
  })

  it('keeps a non-0x value verbatim — the key stays a pure function of legacy row fields', () => {
    const tron = 'TAXonvq4chZufsFS1NdTLaK4zq8ruPct8f' as Address
    expect(
      computeTaskKey('facet-removal', 'tron', EnvironmentEnum.production, tron)
    ).toBe(`facet-removal|tron|production|${tron}`)
  })

  it('gives two versions of one facet, co-registered on a diamond, distinct keys', () => {
    const args = [
      'facet-removal',
      'mainnet',
      EnvironmentEnum.production,
    ] as const
    expect(computeTaskKey(...args, FACET)).not.toBe(
      computeTaskKey(...args, DIAMOND)
    )
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
      `facet-removal|arbitrum|production|${FACET.toLowerCase()}`
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
      `facet-removal|arbitrum|production|${FACET.toLowerCase()}`
    )
  })

  it('stores an EVM address in its canonical checksummed form', async () => {
    // The stored spelling and the taskKey must not diverge: an address parked in one
    // capitalisation and re-parked in another would otherwise carry two spellings.
    const coll = createFakeCollection()
    await enqueueParkedTask(
      coll,
      buildInput({
        facetAddress: FACET.toUpperCase().replace('0X', '0x') as Address,
      })
    )
    expect(coll.rows[0]?.facetAddress).toBe(getAddress(FACET))
    expect(coll.rows[0]?.taskKey).toBe(
      `facet-removal|arbitrum|production|${FACET.toLowerCase()}`
    )
  })

  it('refuses a non-0x (Tron base58) address — no consumer can drain or reconcile it', async () => {
    const tron = 'TW7Xj4Zt7ZWvhKQyPnzUnFyfLmTsMLGvBn' as unknown as Address
    const coll = createFakeCollection()
    await expectRejects(
      enqueueParkedTask(
        coll,
        buildInput({ network: 'tron', facetAddress: tron })
      ),
      /EVM-only/
    )
    expect(coll.rows).toHaveLength(0)
  })

  it('refuses a mangled EVM address (0x lost in copy-paste)', async () => {
    const coll = createFakeCollection()
    await expectRejects(
      enqueueParkedTask(
        coll,
        buildInput({ facetAddress: FACET.slice(2) as Address })
      ),
      /EVM-only/
    )
    expect(coll.rows).toHaveLength(0)
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
      `facet-removal|arbitrum|production|${FACET.toLowerCase()}`
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

  it('filters by environment (a staging row never leaks into production reads)', async () => {
    const coll = seed()
    coll.rows.push({
      taskKey: 'facet-removal|arbitrum|staging|A',
      kind: 'facet-removal',
      network: 'arbitrum',
      environment: EnvironmentEnum.staging,
      facetName: 'A',
      diamondAddress: DIAMOND,
      facetAddress: FACET,
      prUrl: 'https://github.com/lifinance/contracts/pull/3',
      status: 'queued',
      enqueuer: 'dev@li.finance',
      createdAt: new Date(),
    })
    const tasks = await listParkedTasks(coll, {
      network: 'arbitrum',
      environment: EnvironmentEnum.production,
      status: 'queued',
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.environment).toBe(EnvironmentEnum.production)
  })

  it('accepts a status array and matches any of them', async () => {
    const coll = seed()
    coll.rows.push({
      ...coll.rows[0],
      taskKey: 'facet-removal|arbitrum|production|C',
      facetName: 'C',
      status: 'proposed',
    } as IParkedTask)
    const open = await listParkedTasks(coll, {
      network: 'arbitrum',
      status: ['queued', 'proposed'],
    })
    expect(open.map((t) => t.status).sort()).toEqual(['proposed', 'queued'])
  })

  it('returns tasks in taskKey order, so the drain claims in the order the execute-time zip replays them', async () => {
    // Seeded deliberately out of order — an unsorted read would return C, A, B.
    const row = (facetName: string): IParkedTask => ({
      taskKey: `facet-removal|arbitrum|production|${facetName}`,
      kind: 'facet-removal',
      network: 'arbitrum',
      environment: EnvironmentEnum.production,
      facetName,
      diamondAddress: DIAMOND,
      facetAddress: FACET,
      prUrl: 'https://github.com/lifinance/contracts/pull/1',
      status: 'queued',
      enqueuer: 'dev@li.finance',
      createdAt: new Date(),
    })
    const coll = createFakeCollection([row('C'), row('A'), row('B')])
    const keys = (await listParkedTasks(coll, {})).map((t) => t.taskKey)
    expect(keys).toEqual([
      'facet-removal|arbitrum|production|A',
      'facet-removal|arbitrum|production|B',
      'facet-removal|arbitrum|production|C',
    ])
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
  function taskRow(
    status: IParkedTask['status'],
    id: ObjectId = new ObjectId()
  ): WithId<IParkedTask> {
    return {
      _id: id,
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
      resolvedAt: new Date(),
    }
  }
  function seedOne(status: IParkedTask['status']): IFakeCollection {
    return createFakeCollection([taskRow(status)])
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

  it('reopenResolvedTask flips executed→queued and clears the resolution + proposal linkage', async () => {
    const coll = seedOne('executed')
    const doc = await reopenResolvedTask(coll, idOf(coll, 0))
    expect(doc?.status).toBe('queued')
    expect(doc?.resolvedAt).toBeUndefined()
    expect(doc?.proposedAt).toBeUndefined()
    expect(doc?.safeTxHash).toBeUndefined()
  })

  it('reopenResolvedTask flips superseded→queued', async () => {
    const coll = seedOne('superseded')
    expect((await reopenResolvedTask(coll, idOf(coll, 0)))?.status).toBe(
      'queued'
    )
  })

  it('reopenResolvedTask refuses a cancelled task (deliberate operator decision)', async () => {
    const coll = seedOne('cancelled')
    expect(await reopenResolvedTask(coll, idOf(coll, 0))).toBeNull()
    expect(coll.rows[0]?.status).toBe('cancelled')
  })

  it('reopenResolvedTask is a no-op (null) on an already-open task', async () => {
    const coll = seedOne('queued')
    expect(await reopenResolvedTask(coll, idOf(coll, 0))).toBeNull()
  })

  it('reopenResolvedTask returns null instead of throwing when an open task already tracks the facet', async () => {
    const coll = createFakeCollection([taskRow('executed'), taskRow('queued')])
    expect(await reopenResolvedTask(coll, idOf(coll, 0))).toBeNull()
    expect(coll.rows[0]?.status).toBe('executed')
  })

  it('reopenResolvedTask recomputes a legacy name-based key so dedup applies again', async () => {
    // KEY above is the legacy name form; without the recompute the row
    // re-enters the open index under a key no fresh enqueue can collide with.
    const coll = seedOne('executed')
    const doc = await reopenResolvedTask(coll, idOf(coll, 0))
    expect(doc?.taskKey).toBe(
      `facet-removal|arbitrum|production|${FACET.toLowerCase()}`
    )
  })

  it('reopenResolvedTask refuses when an ADDRESS-keyed open task tracks the same facet', async () => {
    const legacy = taskRow('executed')
    const open = taskRow('queued')
    open.taskKey = `facet-removal|arbitrum|production|${FACET.toLowerCase()}`
    const coll = createFakeCollection([legacy, open])
    expect(await reopenResolvedTask(coll, idOf(coll, 0))).toBeNull()
    expect(coll.rows[0]?.status).toBe('executed')
  })

  it('reopens the exact row it was given when one taskKey owns several terminal rows', async () => {
    // The partial unique index covers only the open statuses, so parked → executed →
    // re-parked → executed leaves two terminal rows under one key. Matching by key
    // would let the store pick either, and the caller would report the wrong one.
    const first = taskRow('executed')
    const second = taskRow('superseded')
    const coll = createFakeCollection([first, second])

    const doc = await reopenResolvedTask(coll, second._id)

    expect(doc?._id).toEqual(second._id)
    expect(coll.rows[1]?.status).toBe('queued')
    expect(coll.rows[0]?.status).toBe('executed')
  })
})

describe('setSafeTxHash', () => {
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
      },
    ])
  }

  it('links a proposed task to its minted proposal', async () => {
    const coll = seedOne('proposed')
    const updated = await setSafeTxHash(coll, KEY, '0xdeadbeef')
    expect(updated?.safeTxHash).toBe('0xdeadbeef')
    expect(coll.rows[0]?.safeTxHash).toBe('0xdeadbeef')
    expect(coll.rows[0]?.status).toBe('proposed')
  })

  it('returns null when the task is not proposed (e.g. still queued)', async () => {
    const coll = seedOne('queued')
    expect(await setSafeTxHash(coll, KEY, '0xdeadbeef')).toBeNull()
    expect(coll.rows[0]?.safeTxHash).toBeUndefined()
  })

  it('returns null for an unknown taskKey', async () => {
    const coll = seedOne('proposed')
    expect(await setSafeTxHash(coll, 'nope', '0xabc')).toBeNull()
  })
})

describe('listParkedTasksBySafeTxHash', () => {
  it('returns tasks for the hash sorted by proposedAt ascending', async () => {
    const hash = '0xdeadbeef'
    const earlier = new Date('2026-01-01T00:00:00Z')
    const later = new Date('2026-01-02T00:00:00Z')
    const coll = createFakeCollection([
      {
        taskKey: 'facet-removal|arbitrum|production|B',
        kind: 'facet-removal',
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facetName: 'B',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: PR_URL,
        status: 'proposed',
        enqueuer: 'dev@li.finance',
        createdAt: later,
        proposedAt: later,
        safeTxHash: hash,
      },
      {
        taskKey: 'facet-removal|arbitrum|production|A',
        kind: 'facet-removal',
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facetName: 'A',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: PR_URL,
        status: 'proposed',
        enqueuer: 'dev@li.finance',
        createdAt: earlier,
        proposedAt: earlier,
        safeTxHash: hash,
      },
      {
        taskKey: 'facet-removal|arbitrum|production|C',
        kind: 'facet-removal',
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facetName: 'C',
        diamondAddress: DIAMOND,
        facetAddress: FACET,
        prUrl: PR_URL,
        status: 'proposed',
        enqueuer: 'dev@li.finance',
        createdAt: earlier,
        proposedAt: earlier,
        safeTxHash: '0xother',
      },
    ])
    const rows = await listParkedTasksBySafeTxHash(coll, hash)
    expect(rows.map((r) => r.facetName)).toEqual(['A', 'B'])
  })

  it('returns empty when no task carries the hash', async () => {
    const coll = createFakeCollection()
    expect(await listParkedTasksBySafeTxHash(coll, '0xmissing')).toEqual([])
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

  it('tolerates a not-authorized createIndex (code 13) when the index already exists', async () => {
    const err = Object.assign(
      new Error('not authorized on deferred-cleanup to execute command'),
      { code: 13 }
    )
    const coll = createFakeCollection([], {
      createIndexError: err,
      existingIndexes: [{ name: '_id_' }, { name: 'unique_open_task_key' }],
    })
    await ensureParkedTasksIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(1)
  })

  it('tolerates a not-authorized createIndex matched by message when code is absent', async () => {
    const err = new Error(
      'not authorized on deferred-cleanup to execute command { createIndexes: ... }'
    )
    const coll = createFakeCollection([], {
      createIndexError: err,
      existingIndexes: [{ name: 'unique_open_task_key' }],
    })
    await ensureParkedTasksIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(1)
  })

  it('proceeds non-fatally when not authorized and the index is missing', async () => {
    const err = Object.assign(new Error('not authorized on deferred-cleanup'), {
      code: 13,
    })
    const coll = createFakeCollection([], {
      createIndexError: err,
      existingIndexes: [{ name: '_id_' }],
    })
    await ensureParkedTasksIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(1)
  })

  it('proceeds non-fatally when not authorized and listIndexes also fails', async () => {
    const err = Object.assign(new Error('not authorized on deferred-cleanup'), {
      code: 13,
    })
    const listErr = Object.assign(new Error('not authorized to listIndexes'), {
      code: 13,
    })
    const coll = createFakeCollection([], {
      createIndexError: err,
      listIndexesError: listErr,
    })
    await ensureParkedTasksIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(1)
  })
})
