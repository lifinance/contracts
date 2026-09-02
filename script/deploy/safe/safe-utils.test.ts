/**
 * Tests for the duplicate-proposal protection in safe-utils (EXSC-117).
 *
 * `storeTransactionInMongoDB` persists an `intentHash` on every proposal and
 * MongoDB enforces a partial unique index (`unique_pending_intent_hash`) on
 * `{ intentHash }` filtered by `{ status: 'pending' }`. The suite covers the
 * hash derivation (determinism, nonce exclusion, field sensitivity) and the
 * store behavior against an in-memory collection fake that mirrors the
 * partial-unique-index semantics: duplicate PENDING rejected (E11000 -> null,
 * no throw), re-create after EXECUTED/REVERTED allowed, and non-duplicate
 * errors propagated.
 *
 * Also covers the nonce-execution gate (EXSC-690): `canExecuteWithNonceStatus`
 * decides whether a pending proposal may be broadcast given where its nonce sits
 * relative to the Safe's expected nonce, and `isFutureNonceExecutionAllowed`
 * reads the operator escape hatch that the gate consults for the future case.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection, type InsertOneResult, type ObjectId } from 'mongodb'
import {
  decodeFunctionData,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
} from 'viem'

import { getRPCEnvVarName } from '../../utils/utils'

import { normalizeProposalReason } from './proposal-intent'
import {
  buildProposalProvenance,
  canExecuteWithNonceStatus,
  classifyDuplicateKeyError,
  pickTimelockSalt,
  wrapWithTimelockSchedule,
  classifyIndexEnsureFailure,
  computeProposalIntentHash,
  getSelector,
  getSigners,
  isFutureNonceExecutionAllowed,
  mongoSafeTxRowFilter,
  safeTxStatusConsumedNonce,
  serializeSafeTxForMongo,
  storeTransactionInMongoDB,
  summarizeProposalDoc,
  OperationTypeEnum,
  type IProposalProvenance,
  type ISafeTransaction,
  type ISafeTxDocument,
  type NonceExecutionDecision,
  type SafeNonceStatus,
} from './safe-utils'
import {
  TIMELOCK_OPERATION_STATE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_ZERO_PREDECESSOR,
  deriveTimelockSalt,
} from './timelock-abi'

const SAFE_ADDR = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const PROPOSER = '0x3333333333333333333333333333333333333333' as Address
const NETWORK = 'mainnet'
const CHAIN_ID = 1

function buildSafeTx(
  overrides: Partial<{
    to: Address
    value: bigint
    data: Hex
    operation: OperationTypeEnum
    nonce: bigint
  }> = {}
): ISafeTransaction {
  return {
    data: {
      to: TARGET,
      value: 0n,
      data: '0xdeadbeef' as Hex,
      operation: OperationTypeEnum.Call,
      nonce: 0n,
      ...overrides,
    },
    signatures: new Map(),
  }
}

class FakeDuplicateKeyError extends Error {
  public code = 11000
  public constructor() {
    super(
      'E11000 duplicate key error collection: sc_private.pendingTransactions index: unique_pending_intent_hash'
    )
  }
}

/**
 * In-memory stand-in for the `pendingTransactions` collection that replicates
 * the `unique_pending_intent_hash` partial unique index: inserting a doc whose
 * `intentHash` already exists on a row with `status: 'pending'` throws a
 * duplicate-key error with code 11000, exactly like MongoDB would.
 */
function createFakeCollection(
  initial: ISafeTxDocument[] = [],
  options: { insertError?: Error } = {}
): Collection<ISafeTxDocument> & { rows: ISafeTxDocument[] } {
  const rows: ISafeTxDocument[] = initial.map((r) => ({ ...r }))
  const api = {
    rows,
    async insertOne(doc: ISafeTxDocument): Promise<InsertOneResult> {
      if (options.insertError) throw options.insertError
      const duplicate = rows.some(
        (r) =>
          r.status === 'pending' &&
          r.intentHash !== undefined &&
          r.intentHash === doc.intentHash
      )
      if (duplicate) throw new FakeDuplicateKeyError()
      rows.push({ ...doc })
      return {
        acknowledged: true,
        insertedId: rows.length,
      } as unknown as InsertOneResult
    },
  }
  return api as unknown as Collection<ISafeTxDocument> & {
    rows: ISafeTxDocument[]
  }
}

/**
 * Frozen provenance handed to every `store()` call. Without an override the
 * storage funnel captures ambient git state, which would make this suite spawn
 * subprocesses and assert against whatever checkout it happens to run in.
 */
const FIXED_PROVENANCE: IProposalProvenance = {
  actor: 'human',
  proposerHandle: 'Test User <test@example.com>',
  gitCommit: 'a'.repeat(40),
  gitBranch: 'test-branch',
  dirtyTreeScoped: [],
  capturedAt: '2026-01-01T00:00:00.000Z',
}

const TICKET = 'EXSC-694'
const TICKET_URL = 'https://linear.app/lifi-linear/issue/EXSC-694'

async function store(
  collection: Collection<ISafeTxDocument>,
  safeTx: ISafeTransaction,
  provenance: IProposalProvenance = FIXED_PROVENANCE,
  options: { ticket?: string | undefined; reason?: string | undefined } = {
    ticket: TICKET,
  }
): Promise<InsertOneResult<ISafeTxDocument> | null> {
  return storeTransactionInMongoDB(
    collection,
    SAFE_ADDR,
    NETWORK,
    CHAIN_ID,
    safeTx,
    ('0x' + 'ab'.repeat(32)) as Hex,
    PROPOSER,
    undefined,
    { override: provenance, ticket: options.ticket, reason: options.reason }
  )
}

/**
 * Awaiting bun's `.rejects` matcher trips `@typescript-eslint/await-thenable`
 * because it is not a real Promise, and leaving it un-awaited lets the test
 * finish before the assertion settles.
 *
 * @param promise - The call expected to reject.
 * @param match - Pattern the error message must contain.
 */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toMatch(match)
}

describe('computeProposalIntentHash', () => {
  const hash = (
    overrides: Partial<{
      network: string
      chainId: number
      safeAddress: Address
      to: Address
      value: bigint
      data: Hex
      operation: OperationTypeEnum
    }> = {}
  ) =>
    computeProposalIntentHash(
      overrides.network ?? NETWORK,
      overrides.chainId ?? CHAIN_ID,
      overrides.safeAddress ?? SAFE_ADDR,
      overrides.to ?? TARGET,
      overrides.value ?? 0n,
      overrides.data ?? ('0xdeadbeef' as Hex),
      overrides.operation ?? OperationTypeEnum.Call
    )

  it('is deterministic for identical inputs', () => {
    expect(hash()).toEqual(hash())
  })

  it('normalizes network casing so MAINNET and mainnet collide', () => {
    expect(hash({ network: 'MAINNET' })).toEqual(hash({ network: 'mainnet' }))
  })

  it('changes when any identity field changes', () => {
    const base = hash()
    expect(hash({ network: 'arbitrum' })).not.toEqual(base)
    expect(hash({ chainId: 42161 })).not.toEqual(base)
    expect(hash({ safeAddress: PROPOSER })).not.toEqual(base)
    expect(hash({ to: PROPOSER })).not.toEqual(base)
    expect(hash({ value: 1n })).not.toEqual(base)
    expect(hash({ data: '0xcafe' as Hex })).not.toEqual(base)
    expect(hash({ operation: OperationTypeEnum.DelegateCall })).not.toEqual(
      base
    )
  })
})

describe('storeTransactionInMongoDB — duplicate-PENDING protection', () => {
  it('stores a new proposal with intentHash and status pending', async () => {
    const collection = createFakeCollection()

    const result = await store(collection, buildSafeTx())

    expect(result).not.toBeNull()
    expect(result?.acknowledged).toBe(true)
    expect(collection.rows).toHaveLength(1)
    const doc = collection.rows[0]
    expect(doc?.status).toEqual('pending')
    expect(doc?.intentHash).toEqual(
      computeProposalIntentHash(
        NETWORK,
        CHAIN_ID,
        SAFE_ADDR,
        TARGET,
        0n,
        '0xdeadbeef' as Hex,
        OperationTypeEnum.Call
      )
    )
  })

  it('rejects a duplicate PENDING proposal: returns null, no second doc, no throw', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx())
    const second = await store(collection, buildSafeTx())

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(collection.rows).toHaveLength(1)
  })

  it('treats proposals differing only in nonce as duplicates', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx({ nonce: 5n }))
    const second = await store(collection, buildSafeTx({ nonce: 6n }))

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(collection.rows).toHaveLength(1)
  })

  it('allows repeated idempotent pushes in one run without failing', async () => {
    const collection = createFakeCollection()

    for (let i = 0; i < 3; i++) await store(collection, buildSafeTx())

    expect(collection.rows).toHaveLength(1)
  })

  it('accepts a proposal whose hash matches only an EXECUTED proposal', async () => {
    const collection = createFakeCollection()
    const first = await store(collection, buildSafeTx())
    expect(first).not.toBeNull()
    const executedDoc = collection.rows[0]
    if (!executedDoc) throw new Error('expected stored doc')
    executedDoc.status = 'executed'

    const recreated = await store(collection, buildSafeTx())

    expect(recreated).not.toBeNull()
    expect(recreated?.acknowledged).toBe(true)
    expect(collection.rows).toHaveLength(2)
    expect(collection.rows.map((r) => r.status).sort()).toEqual([
      'executed',
      'pending',
    ])
  })

  it('accepts a proposal whose hash matches only a REVERTED proposal', async () => {
    const collection = createFakeCollection()
    const first = await store(collection, buildSafeTx())
    expect(first).not.toBeNull()
    const revertedDoc = collection.rows[0]
    if (!revertedDoc) throw new Error('expected stored doc')
    revertedDoc.status = 'reverted'

    const recreated = await store(collection, buildSafeTx())

    expect(recreated).not.toBeNull()
    expect(collection.rows).toHaveLength(2)
  })

  it('different proposals coexist as pending', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx())
    const second = await store(
      collection,
      buildSafeTx({ data: '0xcafe' as Hex })
    )

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(collection.rows).toHaveLength(2)
  })

  it('propagates non-duplicate insert errors instead of swallowing them', async () => {
    const collection = createFakeCollection([], {
      insertError: new Error('connection reset'),
    })

    let thrown: unknown
    try {
      await store(collection, buildSafeTx())
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toEqual('connection reset')
    expect(collection.rows).toHaveLength(0)
  })
})

/**
 * Tests for provenance capture at the storage funnel (EXSC-692). Everything
 * here drives the `override` seam so no test spawns `git`; ambient capture
 * itself is covered in `script/deploy/shared/git-provenance.test.ts`.
 */
describe('storeTransactionInMongoDB — the ticket link hard-blocks', () => {
  const originalTicket = process.env.SAFE_PROPOSAL_TICKET

  beforeEach(() => {
    delete process.env.SAFE_PROPOSAL_TICKET
  })

  afterEach(() => {
    if (originalTicket === undefined) delete process.env.SAFE_PROPOSAL_TICKET
    else process.env.SAFE_PROPOSAL_TICKET = originalTicket
  })

  it('does not create a proposal when no ticket was supplied', async () => {
    const collection = createFakeCollection()

    await expectRejects(
      store(collection, buildSafeTx(), FIXED_PROVENANCE, { ticket: undefined }),
      /SAFE_PROPOSAL_TICKET/
    )

    // "Not created" is the requirement, not "reported an error": a throw after
    // the insert would leave an unlinked proposal occupying a nonce.
    expect(collection.rows).toHaveLength(0)
  })

  it('refuses a malformed ticket rather than storing it as a link', async () => {
    const collection = createFakeCollection()

    await expectRejects(
      store(collection, buildSafeTx(), FIXED_PROVENANCE, {
        ticket: 'https://example.com/issue/EXSC-694',
      }),
      /not a Linear issue link/
    )
    expect(collection.rows).toHaveLength(0)
  })

  it('records the ticket URL on the stored proposal', async () => {
    const collection = createFakeCollection()

    await store(collection, buildSafeTx())

    expect(collection.rows[0]?.provenance?.ticketUrl).toBe(TICKET_URL)
  })

  it('accepts the ticket from the environment, so bash flows need no new argument', async () => {
    process.env.SAFE_PROPOSAL_TICKET = 'EXSC-222'
    const collection = createFakeCollection()

    await store(collection, buildSafeTx(), FIXED_PROVENANCE, {
      ticket: undefined,
    })

    expect(collection.rows[0]?.provenance?.ticketUrl).toBe(
      'https://linear.app/lifi-linear/issue/EXSC-222'
    )
  })

  it('creates the proposal with no reason — only the ticket blocks (OQ3)', async () => {
    const collection = createFakeCollection()

    const result = await store(collection, buildSafeTx())

    expect(result).not.toBeNull()
    expect(collection.rows[0]?.provenance?.reason).toBeUndefined()
    expect(collection.rows[0]?.provenance?.ticketUrl).toBe(TICKET_URL)
  })
})

describe('storeTransactionInMongoDB — provenance', () => {
  const originalReason = process.env.SAFE_PROPOSAL_REASON

  beforeEach(() => {
    delete process.env.SAFE_PROPOSAL_REASON
  })

  afterEach(() => {
    if (originalReason === undefined) delete process.env.SAFE_PROPOSAL_REASON
    else process.env.SAFE_PROPOSAL_REASON = originalReason
  })

  it('writes the provenance block onto the stored row', async () => {
    const collection = createFakeCollection()

    await store(collection, buildSafeTx())

    expect(collection.rows[0]?.provenance).toEqual({
      ...FIXED_PROVENANCE,
      ticketUrl: TICKET_URL,
    })
  })

  it('stores the reason the resolver settled on, not the raw flag', async () => {
    // The funnel resolves the reason once to decide whether to warn. Storing a
    // separately-derived value lets a proposal be recorded reasonless while the
    // operator saw no warning, and the adoption counter reads the stored field.
    process.env.SAFE_PROPOSAL_REASON = 'rotate the pauser key'
    const collection = createFakeCollection()

    await store(collection, buildSafeTx(), FIXED_PROVENANCE, {
      ticket: TICKET,
      reason: '',
    })

    expect(collection.rows[0]?.provenance?.reason).toBe('rotate the pauser key')
  })

  it('keeps provenance out of the intent hash', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx())
    const second = await store(collection, buildSafeTx(), {
      ...FIXED_PROVENANCE,
      gitCommit: 'b'.repeat(40),
      gitBranch: 'another-branch',
    })

    // Same transaction, different provenance: still one pending proposal.
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(collection.rows).toHaveLength(1)
  })

  it('captures once for a retried insert rather than per attempt', async () => {
    let attempts = 0
    const rows: ISafeTxDocument[] = []
    const flaky = {
      async insertOne(doc: ISafeTxDocument): Promise<InsertOneResult> {
        attempts++
        if (attempts < 3) throw new Error('connection reset')
        rows.push({ ...doc })
        return {
          acknowledged: true,
          insertedId: rows.length,
        } as unknown as InsertOneResult
      },
    } as unknown as Collection<ISafeTxDocument>

    await store(flaky, buildSafeTx())

    expect(attempts).toBe(3)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provenance?.capturedAt).toBe(FIXED_PROVENANCE.capturedAt)
  })

  it('stores a Tron-shaped document, which has a hand-built safeTx', async () => {
    const collection = createFakeCollection()
    // The Tron route casts a plain object into ISafeTransaction; capture must
    // not read safeTx, so this must still store cleanly.
    const tronSafeTx = {
      data: {
        to: TARGET,
        value: 0n,
        data: '0xdeadbeef' as Hex,
        operation: OperationTypeEnum.Call,
        nonce: 3n,
      },
      signatures: {},
    } as unknown as ISafeTransaction

    const result = await store(collection, tronSafeTx)

    expect(result).not.toBeNull()
    expect(collection.rows[0]?.provenance).toEqual({
      ...FIXED_PROVENANCE,
      ticketUrl: TICKET_URL,
    })
  })
})

describe('buildProposalProvenance', () => {
  const originalReason = process.env.SAFE_PROPOSAL_REASON

  beforeEach(() => {
    delete process.env.SAFE_PROPOSAL_REASON
  })

  afterEach(() => {
    if (originalReason === undefined) delete process.env.SAFE_PROPOSAL_REASON
    else process.env.SAFE_PROPOSAL_REASON = originalReason
  })

  it('returns the override untouched when no reason is supplied', () => {
    expect(buildProposalProvenance({ override: FIXED_PROVENANCE })).toEqual(
      FIXED_PROVENANCE
    )
  })

  it('folds an explicit reason onto a block that has none', () => {
    expect(
      buildProposalProvenance({
        override: FIXED_PROVENANCE,
        reason: '  sync   whitelist  ',
      }).reason
    ).toBe('sync whitelist')
  })

  it('falls back to SAFE_PROPOSAL_REASON when no reason is passed', () => {
    process.env.SAFE_PROPOSAL_REASON = 'whitelist sync stage 4c'

    expect(buildProposalProvenance({ override: FIXED_PROVENANCE }).reason).toBe(
      'whitelist sync stage 4c'
    )
  })

  it('prefers an explicit reason over the environment', () => {
    process.env.SAFE_PROPOSAL_REASON = 'from env'

    expect(
      buildProposalProvenance({
        override: FIXED_PROVENANCE,
        reason: 'from caller',
      }).reason
    ).toBe('from caller')
  })

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
  ])(
    'falls back to the environment when the caller passes %s',
    (_label, reason) => {
      // A bare `--reason` arrives as '', which `??` treats as supplied. The
      // resolver applies the same rule, and the two must not disagree about
      // whether a reason was given — one drives the warning, this one the field.
      process.env.SAFE_PROPOSAL_REASON = 'rotate the pauser key'

      expect(
        buildProposalProvenance({ override: FIXED_PROVENANCE, reason }).reason
      ).toBe('rotate the pauser key')
    }
  )

  it('never overwrites a reason the block already carries', () => {
    expect(
      buildProposalProvenance({
        override: { ...FIXED_PROVENANCE, reason: 'already recorded' },
        reason: 'late arrival',
      }).reason
    ).toBe('already recorded')
  })

  it('omits the reason key entirely when there is nothing to record', () => {
    process.env.SAFE_PROPOSAL_REASON = '   '

    const provenance = buildProposalProvenance({ override: FIXED_PROVENANCE })

    expect('reason' in provenance).toBe(false)
  })

  it('returns a copy so the caller cannot mutate the stored arrays', () => {
    const override: IProposalProvenance = {
      ...FIXED_PROVENANCE,
      dirtyTreeScoped: ['src/Facets/Foo.sol'],
    }

    const stored = buildProposalProvenance({ override })
    stored.dirtyTreeScoped.push('injected')

    expect(override.dirtyTreeScoped).toEqual(['src/Facets/Foo.sol'])
  })

  it('sanitizes override fields so the seam cannot store raw controls', () => {
    const esc = String.fromCharCode(27)
    const stored = buildProposalProvenance({
      override: {
        ...FIXED_PROVENANCE,
        proposerHandle: `Mallory${esc}[2J`,
        gitBranch: `feat/x${esc}`,
      },
    })

    expect(stored.proposerHandle).toBe('Mallory[2J')
    expect(stored.gitBranch).toBe('feat/x')
    expect(stored.proposerHandle).not.toContain(esc)
  })
})

describe('normalizeProposalReason', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeProposalReason('  add \n  AcrossFacetV4  ')).toBe(
      'add AcrossFacetV4'
    )
  })

  it('treats empty and whitespace-only input as absent', () => {
    expect(normalizeProposalReason(undefined)).toBeUndefined()
    expect(normalizeProposalReason('')).toBeUndefined()
    expect(normalizeProposalReason('   \t ')).toBeUndefined()
  })

  it('caps an over-long rationale', () => {
    const normalized = normalizeProposalReason('x'.repeat(500))
    expect(normalized).toHaveLength(200)
  })

  // A rationale is proposer-supplied and is rendered into the signing prompt a
  // human reads before approving, so terminal control characters must never
  // survive normalization: they can repaint or erase the prompt around them.
  it('strips control characters a proposer could use to repaint the prompt', () => {
    const esc = String.fromCharCode(27)
    const normalized = normalizeProposalReason(
      `add Facet${esc}[2K${esc}[1;32m VERIFIED${esc}[0m`
    )

    expect(normalized).toBe('add Facet[2K[1;32m VERIFIED[0m')
    expect(normalized).not.toContain(esc)
  })

  // The reason is also the field most likely to be read straight off a Mongo
  // dump, so the same three capabilities denied in the display path — repaint,
  // reverse, forge a line — have to be denied here at write time too.
  it('strips bidi overrides and line separators, not only Cc controls', () => {
    const RLO = '\u202e'
    const LSEP = '\u2028'

    const normalized = normalizeProposalReason(
      `whitelist${RLO} update${LSEP}    Working tree:    clean`
    )

    expect(normalized).not.toContain(RLO)
    expect(normalized).not.toContain(LSEP)
    expect(normalized).toBe('whitelist update Working tree: clean')
  })

  it('keeps legitimate non-ASCII text intact', () => {
    expect(normalizeProposalReason('déployer 日本語 — naïve 👨‍👩‍👧')).toBe(
      'déployer 日本語 — naïve 👨‍👩‍👧'
    )
  })
})

/**
 * Tests for the proposal-summary helpers (getSigners / getSelector /
 * summarizeProposalDoc). They normalize raw MongoDB Safe tx documents
 * (object- or Map-shaped signatures, bigint/number nonces, Date/string
 * timestamps), so these cover each input shape and the malformed-document
 * edge cases.
 */

const SUMMARY_SIGNER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SUMMARY_SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function buildSummaryDoc(
  overrides: Partial<ISafeTxDocument> = {}
): ISafeTxDocument {
  return {
    safeAddress: '0x1111111111111111111111111111111111111111',
    network: 'arbitrum',
    chainId: 42161,
    safeTx: {
      data: {
        to: '0x2222222222222222222222222222222222222222' as Address,
        value: 0n,
        data: '0x1f931c1c0000000000000000000000000000000000000000000000000000000000000060' as Hex,
        operation: 0,
        nonce: 99n,
      },
      signatures: {
        [SUMMARY_SIGNER_A.toLowerCase()]: {
          signer: SUMMARY_SIGNER_A,
          data: '0xsig1',
        },
      },
    } as unknown as ISafeTxDocument['safeTx'],
    safeTxHash: '0xhash',
    proposer: '0x3333333333333333333333333333333333333333',
    timestamp: new Date('2026-06-12T10:00:00.000Z'),
    status: 'pending',
    ...overrides,
  }
}

describe('getSigners', () => {
  it('reads object-shaped signatures and lowercases signer addresses', () => {
    expect(getSigners(buildSummaryDoc())).toEqual([
      SUMMARY_SIGNER_A.toLowerCase(),
    ])
  })

  it('reads Map-shaped signatures (in-memory shape)', () => {
    const doc = buildSummaryDoc()
    doc.safeTx.signatures = new Map([
      [
        SUMMARY_SIGNER_A.toLowerCase(),
        { signer: SUMMARY_SIGNER_A, data: '0xsig1' },
      ],
      [SUMMARY_SIGNER_B, { signer: SUMMARY_SIGNER_B, data: '0xsig2' }],
    ]) as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([
      SUMMARY_SIGNER_A.toLowerCase(),
      SUMMARY_SIGNER_B,
    ])
  })

  it('returns empty for missing signatures', () => {
    const doc = buildSummaryDoc()
    delete (doc.safeTx as unknown as Record<string, unknown>).signatures
    expect(getSigners(doc)).toEqual([])
  })

  it('returns empty for empty signatures object', () => {
    const doc = buildSummaryDoc()
    doc.safeTx.signatures =
      {} as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([])
  })

  it('skips malformed signature entries', () => {
    const doc = buildSummaryDoc()
    doc.safeTx.signatures = {
      a: null,
      b: 'not-an-object',
      c: { data: '0xsig' },
      d: { signer: 12345, data: '0xsig' },
      e: { signer: SUMMARY_SIGNER_B, data: '0xsig2' },
    } as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([SUMMARY_SIGNER_B])
  })
})

describe('getSelector', () => {
  it('extracts the 4-byte selector', () => {
    expect(
      getSelector('0x1f931c1c0000000000000000000000000000000000000060')
    ).toBe('0x1f931c1c')
  })

  it('returns 0x for empty calldata', () => {
    expect(getSelector('0x')).toBe('0x')
  })

  it('returns 0x for short calldata', () => {
    expect(getSelector('0x1f93')).toBe('0x')
  })

  it('returns 0x for non-string input', () => {
    expect(getSelector(undefined)).toBe('0x')
    expect(getSelector(42)).toBe('0x')
  })

  it('returns 0x for non-hex strings', () => {
    expect(getSelector('1f931c1c00000000')).toBe('0x')
  })

  it('returns 0x for 0x-prefixed non-hex characters', () => {
    expect(getSelector('0xzzzzzzzz00000000')).toBe('0x')
  })
})

describe('summarizeProposalDoc', () => {
  it('summarizes a well-formed pending proposal', () => {
    expect(summarizeProposalDoc(buildSummaryDoc())).toEqual({
      network: 'arbitrum',
      chainId: 42161,
      safeAddress: '0x1111111111111111111111111111111111111111',
      nonce: 99,
      to: '0x2222222222222222222222222222222222222222',
      selector: '0x1f931c1c',
      status: 'pending',
      signatureCount: 1,
      signers: [SUMMARY_SIGNER_A.toLowerCase()],
      proposer: '0x3333333333333333333333333333333333333333',
      safeTxHash: '0xhash',
      timestamp: '2026-06-12T10:00:00.000Z',
    })
  })

  it('includes executionHash when present', () => {
    const summary = summarizeProposalDoc(
      buildSummaryDoc({ status: 'executed', executionHash: '0xexec' })
    )
    expect(summary.status).toBe('executed')
    expect(summary.executionHash).toBe('0xexec')
  })

  it('carries parkedTaskRefs through to the summary when present', () => {
    const refs = [
      { facet: 'GenericSwapFacet', prUrl: 'https://gh/pull/2046' },
      { facet: 'AcrossFacetV3', prUrl: 'https://gh/pull/2048' },
    ]
    const summary = summarizeProposalDoc(
      buildSummaryDoc({ parkedTaskRefs: refs })
    )
    expect(summary.parkedTaskRefs).toEqual(refs)
  })

  it('omits parkedTaskRefs when the document has none', () => {
    const summary = summarizeProposalDoc(buildSummaryDoc())
    expect(summary.parkedTaskRefs).toBeUndefined()
  })

  it('handles string timestamps and numeric nonces from raw documents', () => {
    const doc = buildSummaryDoc({
      timestamp: '2026-06-12T11:00:00.000Z' as unknown as Date,
    })
    ;(doc.safeTx.data as unknown as Record<string, unknown>).nonce = 7
    const summary = summarizeProposalDoc(doc)
    expect(summary.timestamp).toBe('2026-06-12T11:00:00.000Z')
    expect(summary.nonce).toBe(7)
  })

  it('defaults missing nested fields without throwing', () => {
    const doc = buildSummaryDoc({ timestamp: undefined as unknown as Date })
    ;(doc as unknown as Record<string, unknown>).safeTx = {}
    const summary = summarizeProposalDoc(doc)
    expect(summary.nonce).toBe(0)
    expect(summary.to).toBe('')
    expect(summary.selector).toBe('0x')
    expect(summary.signatureCount).toBe(0)
    expect(summary.timestamp).toBe('')
  })
})

describe('mongoSafeTxRowFilter', () => {
  it('prefers _id when present', () => {
    const id = { toString: () => 'abc' } as ObjectId
    expect(
      mongoSafeTxRowFilter(
        {
          _id: id,
          safeAddress: SAFE_ADDR,
          network: NETWORK,
          chainId: CHAIN_ID,
          safeTx: buildSafeTx(),
          safeTxHash: '0xhash',
          proposer: PROPOSER,
          timestamp: new Date(),
          status: 'pending',
        },
        NETWORK,
        CHAIN_ID
      )
    ).toEqual({ _id: { $eq: id } })
  })

  it('falls back to pending identity fields without _id', () => {
    expect(
      mongoSafeTxRowFilter(
        {
          safeAddress: SAFE_ADDR,
          network: NETWORK,
          chainId: CHAIN_ID,
          safeTx: buildSafeTx(),
          safeTxHash: '0xhash',
          proposer: PROPOSER,
          timestamp: new Date(),
          status: 'pending',
        },
        NETWORK,
        CHAIN_ID
      )
    ).toEqual({
      status: { $eq: 'pending' },
      safeTxHash: { $eq: '0xhash' },
      network: { $eq: NETWORK },
      chainId: { $eq: CHAIN_ID },
    })
  })
})

describe('serializeSafeTxForMongo', () => {
  it('converts signature Map to plain object', () => {
    const safeTx = buildSafeTx()
    safeTx.signatures.set(PROPOSER.toLowerCase(), {
      signer: PROPOSER,
      data: ('0x' + '11'.repeat(65)) as Hex,
    })
    const stored = serializeSafeTxForMongo(safeTx)
    expect(stored.signatures[PROPOSER.toLowerCase()]?.signer).toEqual(PROPOSER)
    expect(Object.keys(stored.signatures)).toHaveLength(1)
  })
})

describe('safeTxStatusConsumedNonce', () => {
  it('returns true only for executed', () => {
    expect(safeTxStatusConsumedNonce('executed')).toBe(true)
  })

  it('returns false for reverted — a reverted execTransaction rolls back the nonce', () => {
    expect(safeTxStatusConsumedNonce('reverted')).toBe(false)
  })

  it('returns false for submitted (unknown outcome) and pending', () => {
    expect(safeTxStatusConsumedNonce('submitted')).toBe(false)
    expect(safeTxStatusConsumedNonce('pending')).toBe(false)
  })
})

describe('canExecuteWithNonceStatus', () => {
  it.each([
    ['stale', false, { canExecute: false, reason: 'stale-nonce' }],
    ['stale', true, { canExecute: false, reason: 'stale-nonce' }],
    ['future', false, { canExecute: false, reason: 'future-nonce' }],
    ['future', true, { canExecute: true, reason: 'future-nonce-override' }],
    ['current', false, { canExecute: true, reason: 'nonce-current' }],
    ['current', true, { canExecute: true, reason: 'nonce-current' }],
  ] as [SafeNonceStatus, boolean, NonceExecutionDecision][])(
    '%s nonce with allowFutureNonce=%j => %j',
    (status, allowFutureNonce, expected) => {
      expect(canExecuteWithNonceStatus(status, { allowFutureNonce })).toEqual(
        expected
      )
    }
  )
})

describe('isFutureNonceExecutionAllowed', () => {
  const original = process.env.ALLOW_FUTURE_NONCE_EXECUTION
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_FUTURE_NONCE_EXECUTION
    else process.env.ALLOW_FUTURE_NONCE_EXECUTION = original
  })

  it('is true only when ALLOW_FUTURE_NONCE_EXECUTION === "true"', () => {
    process.env.ALLOW_FUTURE_NONCE_EXECUTION = 'true'
    expect(isFutureNonceExecutionAllowed()).toBe(true)
  })

  it('is false when unset', () => {
    delete process.env.ALLOW_FUTURE_NONCE_EXECUTION
    expect(isFutureNonceExecutionAllowed()).toBe(false)
  })

  it('is false for any other value', () => {
    process.env.ALLOW_FUTURE_NONCE_EXECUTION = '1'
    expect(isFutureNonceExecutionAllowed()).toBe(false)
  })
})

describe('decodeDiamondCut selector resolution', () => {
  it('resolves all unknown selectors in a single batched 4byte request', async () => {
    const { decodeDiamondCut } = await import('./safe-utils')
    const originalCachePath = process.env.SELECTOR_SIGNATURE_CACHE_PATH
    const testCachePath = `${
      process.env.TMPDIR ?? '/tmp'
    }/selector-cache-test-${Date.now()}.json`
    process.env.SELECTOR_SIGNATURE_CACHE_PATH = testCachePath
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            function: {
              '0xdeadbe01': [{ name: 'unknownFn1()' }],
              '0xdeadbe02': [{ name: 'unknownFn2()' }],
              '0xdeadbe03': [{ name: 'unknownFn3()' }],
            },
            event: {},
          },
        })
      )
    }) as unknown as typeof fetch
    try {
      await decodeDiamondCut(
        {
          functionName: 'diamondCut',
          args: [
            [
              [
                '0x0000000000000000000000000000000000000000',
                2, // Remove
                ['0xdeadbe01', '0xdeadbe02', '0xdeadbe03'],
              ],
            ],
            '0x0000000000000000000000000000000000000000',
            '0x',
          ],
        },
        1
      )
      expect(fetchCalls).toBeLessThanOrEqual(1)
    } finally {
      globalThis.fetch = originalFetch
      if (originalCachePath === undefined)
        delete process.env.SELECTOR_SIGNATURE_CACHE_PATH
      else process.env.SELECTOR_SIGNATURE_CACHE_PATH = originalCachePath
      const { unlinkSync } = await import('fs')
      try {
        unlinkSync(testCachePath)
      } catch {
        // never written — nothing to clean up
      }
    }
  })
})

describe('safeClientPoolKey', () => {
  it('derives the address from a private key — no key material in the key', async () => {
    const { safeClientPoolKey } = await import('./safe-utils')
    // Well-known anvil test key #0 (public), address 0xf39F...2266
    const anvilKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // pre-commit-checker: not a secret — public anvil dev key
    const key = safeClientPoolKey(
      'mainnet',
      '0x0000000000000000000000000000000000000abc' as Address,
      undefined,
      anvilKey
    )
    expect(key).toContain('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
    expect(key).not.toContain(anvilKey.slice(2, 10))
  })

  it('prefers the account address and lowercases all parts', async () => {
    const { safeClientPoolKey } = await import('./safe-utils')
    const key = safeClientPoolKey(
      'MAINNET',
      '0x0000000000000000000000000000000000000ABC' as Address,
      { address: '0x1111111111111111111111111111111111111111' } as never,
      undefined
    )
    expect(key).toBe(
      'mainnet:0x0000000000000000000000000000000000000abc:0x1111111111111111111111111111111111111111'
    )
  })

  it('falls back to a ledger marker without key material', async () => {
    const { safeClientPoolKey } = await import('./safe-utils')
    const key = safeClientPoolKey(
      'mainnet',
      '0x0000000000000000000000000000000000000abc' as Address,
      undefined,
      undefined
    )
    expect(key.endsWith(':ledger')).toBe(true)
  })
})

describe('getOrCreatePooledPromise', () => {
  it('dedups concurrent callers onto the same promise', async () => {
    const { getOrCreatePooledPromise } = await import('./safe-utils')
    const pool = new Map<string, Promise<string>>()
    let factoryCalls = 0
    const factory = async () => {
      factoryCalls++
      return 'client'
    }
    const p1 = getOrCreatePooledPromise(pool, 'k', factory)
    const p2 = getOrCreatePooledPromise(pool, 'k', factory)
    expect(p1).toBe(p2)
    expect(await p1).toBe('client')
    expect(factoryCalls).toBe(1)
  })

  it('evicts a rejected promise so the next call retries', async () => {
    const { getOrCreatePooledPromise } = await import('./safe-utils')
    const pool = new Map<string, Promise<string>>()
    let factoryCalls = 0
    const factory = async () => {
      factoryCalls++
      if (factoryCalls === 1) throw new Error('transient RPC blip')
      return 'client'
    }
    let firstError: unknown
    try {
      await getOrCreatePooledPromise(pool, 'k', factory)
    } catch (error) {
      firstError = error
    }
    expect((firstError as Error).message).toBe('transient RPC blip')
    expect(pool.has('k')).toBe(false)
    expect(await getOrCreatePooledPromise(pool, 'k', factory)).toBe('client')
    expect(factoryCalls).toBe(2)
  })

  it('does not evict a newer replacement entry on stale rejection', async () => {
    const { getOrCreatePooledPromise } = await import('./safe-utils')
    const pool = new Map<string, Promise<string>>()
    let rejectFirst: ((e: Error) => void) | undefined
    const first = getOrCreatePooledPromise(
      pool,
      'k',
      () =>
        new Promise<string>((_, reject) => {
          rejectFirst = reject
        })
    )
    // Simulate an out-of-band replacement (e.g. manual eviction + re-init)
    const replacement = Promise.resolve('replacement')
    pool.set('k', replacement)
    rejectFirst?.(new Error('stale failure'))
    let staleError: unknown
    try {
      await first
    } catch (error) {
      staleError = error
    }
    expect((staleError as Error).message).toBe('stale failure')
    expect(pool.get('k')).toBe(replacement)
  })
})

describe('releaseAllPooledSafeClients', () => {
  it('cleans up every pooled client, tolerates failures, and clears the pool', async () => {
    const { releaseAllPooledSafeClients } = await import('./safe-utils')
    const cleaned: string[] = []
    const makeBundle = (name: string, failCleanup = false) =>
      Promise.resolve({
        safe: {
          cleanup: async () => {
            if (failCleanup) throw new Error(`cleanup failed for ${name}`)
            cleaned.push(name)
          },
        },
        chain: undefined,
        safeAddress: '0x0' as Address,
      }) as never
    const pool = new Map([
      ['a', makeBundle('a')],
      ['b', makeBundle('b', true)],
      ['c', makeBundle('c')],
    ])
    await releaseAllPooledSafeClients(pool as never)
    expect(cleaned.sort()).toEqual(['a', 'c'])
    expect(pool.size).toBe(0)
  })

  it('does not hang on a never-settling in-flight client and still clears the pool', async () => {
    const { releaseAllPooledSafeClients } = await import('./safe-utils')
    // A pooled promise that never resolves (e.g. a prefetch init against a hung
    // RPC) must not stall shutdown past the timeout.
    const pool = new Map([['stuck', new Promise(() => undefined)]])
    const startedAt = Date.now()
    await releaseAllPooledSafeClients(pool as never, 20) // 20ms deadline
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(pool.size).toBe(0)
  })
})

describe('SafeClient.signTransaction chain id source', () => {
  const makeClient = async (knownChainId?: number) => {
    const { SafeClient } = await import('./safe-utils')
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    )
    let rpcChainIdCalls = 0
    const domains: { chainId: number }[] = []
    const publicClient = {
      getChainId: async () => {
        rpcChainIdCalls++
        return 999
      },
    }
    const walletClient = {
      signTypedData: async (params: { domain: { chainId: number } }) => {
        domains.push(params.domain)
        return `0x${'ab'.repeat(65)}`
      },
    }
    const client = new SafeClient(
      publicClient as never,
      walletClient as never,
      SAFE_ADDR,
      account,
      undefined,
      knownChainId
    )
    return {
      client,
      domains,
      rpcChainIdCalls: () => rpcChainIdCalls,
    }
  }

  it('uses the config-resolved chain id without an RPC round trip', async () => {
    const { client, domains, rpcChainIdCalls } = await makeClient(42161)
    const signed = await client.signTransaction(buildSafeTx())
    expect(rpcChainIdCalls()).toBe(0)
    expect(domains[0]?.chainId).toBe(42161)
    expect(signed.signatures.size).toBe(1)
  })

  it('falls back to the RPC chain id when no config id is known', async () => {
    const { client, domains, rpcChainIdCalls } = await makeClient(undefined)
    await client.signTransaction(buildSafeTx())
    expect(rpcChainIdCalls()).toBe(1)
    expect(domains[0]?.chainId).toBe(999)
  })
})

/**
 * Real MongoDB 8.2 supplies `keyPattern` and names the index in the message; an
 * older driver or a mongos in the path may only supply the message. Both shapes
 * are covered because the classifier decides whether a collision is swallowed as
 * an idempotent re-propose or surfaced as a lost nonce race.
 */
class FakeNonceDuplicateKeyError extends Error {
  public code = 11000
  public keyPattern = {
    safeAddress: 1,
    network: 1,
    chainId: 1,
    'safeTx.data.nonce': 1,
  }
  public constructor() {
    super(
      'E11000 duplicate key error collection: sc_private.pendingTransactions index: unique_inflight_safe_nonce_ci dup key: { safeAddress: "0x11", network: "mainnet", chainId: 1, safeTx.data.nonce: 5 }'
    )
  }
}

describe('classifyDuplicateKeyError', () => {
  it('is not-duplicate for a non-11000 error', () => {
    expect(classifyDuplicateKeyError(new Error('connection reset'))).toBe(
      'not-duplicate'
    )
  })

  it('is not-duplicate for a non-Error value', () => {
    expect(classifyDuplicateKeyError('nope')).toBe('not-duplicate')
  })

  it('recognises the intent index from keyPattern', () => {
    const error = Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { intentHash: 1 },
    })

    expect(classifyDuplicateKeyError(error)).toBe('intent')
  })

  it('recognises the in-flight nonce index from keyPattern', () => {
    expect(classifyDuplicateKeyError(new FakeNonceDuplicateKeyError())).toBe(
      'in-flight-nonce'
    )
  })

  it('falls back to the index name when keyPattern is absent', () => {
    expect(classifyDuplicateKeyError(new FakeDuplicateKeyError())).toBe(
      'intent'
    )
  })

  it('recognises the nonce index from the message alone', () => {
    const error = Object.assign(
      new Error(
        'E11000 duplicate key error collection: sc_private.pendingTransactions index: unique_inflight_safe_nonce_ci'
      ),
      { code: 11000 }
    )

    expect(classifyDuplicateKeyError(error)).toBe('in-flight-nonce')
  })

  it('recognises the pre-collation index, which is never dropped and can still fire', () => {
    const error = Object.assign(
      new Error(
        'E11000 duplicate key error collection: sc_private.pendingTransactions index: unique_inflight_safe_nonce'
      ),
      { code: 11000 }
    )

    expect(classifyDuplicateKeyError(error)).toBe('in-flight-nonce')
  })

  it('is other for an 11000 on some unrelated index', () => {
    const error = Object.assign(
      new Error(
        'E11000 duplicate key error collection: sc_private.pendingTransactions index: _id_'
      ),
      { code: 11000, keyPattern: { _id: 1 } }
    )

    expect(classifyDuplicateKeyError(error)).toBe('other')
  })
})

describe('storeTransactionInMongoDB — nonce collision is not an idempotent duplicate', () => {
  it('throws instead of returning null when the in-flight nonce index fires', async () => {
    const collection = createFakeCollection([], {
      insertError: new FakeNonceDuplicateKeyError(),
    })

    let thrown: unknown
    try {
      await store(collection, buildSafeTx())
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/nonce/i)
    expect(collection.rows).toHaveLength(0)
  })

  it('still returns null for a duplicate intent, so re-proposing stays idempotent', async () => {
    const collection = createFakeCollection([], {
      insertError: new FakeDuplicateKeyError(),
    })

    expect(await store(collection, buildSafeTx())).toBeNull()
  })

  it('propagates an unrelated 11000 rather than guessing', async () => {
    const error = Object.assign(new Error('E11000 index: _id_'), {
      code: 11000,
      keyPattern: { _id: 1 },
    })
    const collection = createFakeCollection([], { insertError: error })

    let thrown: unknown
    try {
      await store(collection, buildSafeTx())
    } catch (caught) {
      thrown = caught
    }

    expect(thrown).toBe(error)
  })
})

describe('classifyIndexEnsureFailure', () => {
  it('treats a drifted definition as drifted, not fatal — either conflict code', () => {
    expect(classifyIndexEnsureFailure(85)).toBe('drifted')
    expect(classifyIndexEnsureFailure(86)).toBe('drifted')
  })

  it('treats a permission failure as its own outcome', () => {
    expect(classifyIndexEnsureFailure(13)).toBe('unauthorized')
  })

  it('treats colliding data as its own outcome', () => {
    expect(classifyIndexEnsureFailure(11000)).toBe('colliding-data')
  })

  it('treats anything else as fatal, so a real connection fault still propagates', () => {
    expect(classifyIndexEnsureFailure(undefined)).toBe('fatal')
    expect(classifyIndexEnsureFailure(6)).toBe('fatal')
    expect(classifyIndexEnsureFailure(27)).toBe('fatal')
  })
})

/**
 * Fake timelock whose operation id is a function of every field the real contract
 * hashes, and which refuses any read it was not expecting.
 *
 * A loose fake cannot see the address it was called at or which function was
 * asked for — and `getMinDelay`'s non-zero return classifies as `pending`, which
 * would refuse every timelock proposal on every path.
 */
const ozOperationId = (args: readonly unknown[]): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'address[]' },
        { type: 'uint256[]' },
        { type: 'bytes[]' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      args as never
    )
  )

interface IFakeTimelock {
  client: unknown
  /** Operation ids `getTimestamp` was called with, in order. */
  probedIds: string[]
  /** Argument tuples `hashOperationBatch` was called with, in order. */
  hashArgs: unknown[][]
}

const fakeTimelockClient = (
  timestampsByOperationId: Record<string, bigint>,
  expectedAddress: Address
): IFakeTimelock => {
  const probedIds: string[] = []
  const hashArgs: unknown[][] = []
  const client = {
    readContract: async (args: {
      address: Address
      functionName: string
      args: readonly unknown[]
    }): Promise<unknown> => {
      if (args.address !== expectedAddress)
        throw new Error(
          `read at ${args.address}, expected the timelock ${expectedAddress}`
        )

      if (args.functionName === 'hashOperationBatch') {
        hashArgs.push([...args.args])
        return ozOperationId(args.args)
      }

      if (args.functionName === 'getTimestamp') {
        const id = args.args[0] as string
        probedIds.push(id)
        return timestampsByOperationId[id] ?? 0n
      }

      throw new Error(`unexpected read: ${args.functionName}`)
    },
  }
  return { client, probedIds, hashArgs }
}

describe('pickTimelockSalt', () => {
  const action = {
    chainId: 1,
    timelockAddress: '0x1111111111111111111111111111111111111111' as Address,
    // Two distinct calls on purpose: a single-element fixture makes every
    // array-ordering bug a no-op, and two of the converted call sites build
    // multi-element batches.
    targetAddresses: [
      '0x2222222222222222222222222222222222222222',
      '0x4444444444444444444444444444444444444444',
    ] as Address[],
    originalCalldatas: ['0xdeadbeef', '0xfeedface'] as Hex[],
    // Not all-zero: an all-zero fixture cannot observe the `values` parameter, so
    // every pass-through and ordering bug in it becomes a no-op.
    values: [0n, 7n],
  }

  const saltFor = (attempt: number): Hex =>
    deriveTimelockSalt({
      chainId: action.chainId,
      timelockAddress: action.timelockAddress,
      targets: action.targetAddresses,
      payloads: action.originalCalldatas,
      attempt,
    })

  /** The id the real timelock would report for a given attempt's salt. */
  const idFor = (attempt: number): Hex =>
    ozOperationId([
      action.targetAddresses,
      action.values,
      action.originalCalldatas,
      TIMELOCK_ZERO_PREDECESSOR,
      saltFor(attempt),
    ])

  it('uses the first attempt when the timelock knows nothing about it', async () => {
    const { client } = fakeTimelockClient({}, action.timelockAddress)

    expect(
      await pickTimelockSalt({
        ...action,
        client: client as never,
      })
    ).toBe(saltFor(0))
  })

  it('probes the operation it is about to schedule — same targets, payloads and values, zero predecessor', async () => {
    const { client, hashArgs } = fakeTimelockClient({}, action.timelockAddress)

    const salt = await pickTimelockSalt({ ...action, client: client as never })

    expect(hashArgs).toHaveLength(1)
    expect(hashArgs[0]).toEqual([
      action.targetAddresses,
      action.values,
      action.originalCalldatas,
      TIMELOCK_ZERO_PREDECESSOR,
      salt,
    ])
  })

  it('forwards chainId and the timelock into the salt, so one chain cannot predict another', async () => {
    const other = '0x9999999999999999999999999999999999999999' as Address
    const pick = async (over: Partial<typeof action>): Promise<Hex> =>
      pickTimelockSalt({
        ...action,
        ...over,
        client: fakeTimelockClient(
          {},
          over.timelockAddress ?? action.timelockAddress
        ).client as never,
      })

    const base = await pick({})

    expect(await pick({ chainId: 10 })).not.toBe(base)
    expect(await pick({ timelockAddress: other })).not.toBe(base)
  })

  it('probes the id it derived, not the salt', async () => {
    const { client, probedIds } = fakeTimelockClient({}, action.timelockAddress)

    await pickTimelockSalt({ ...action, client: client as never })

    expect(probedIds).toEqual([idFor(0)])
    expect(probedIds[0]).not.toBe(saltFor(0))
  })

  it('is deterministic — two proposers of the same action get the same salt', async () => {
    const first = await pickTimelockSalt({
      ...action,
      client: fakeTimelockClient({}, action.timelockAddress).client as never,
    })
    const second = await pickTimelockSalt({
      ...action,
      client: fakeTimelockClient({}, action.timelockAddress).client as never,
    })

    expect(first).toBe(second)
  })

  it('skips an executed operation and takes the next attempt', async () => {
    const { client } = fakeTimelockClient(
      { [idFor(0)]: 1n },
      action.timelockAddress
    )

    expect(await pickTimelockSalt({ ...action, client: client as never })).toBe(
      saltFor(1)
    )
  })

  it('skips several executed operations in order', async () => {
    const { client, probedIds } = fakeTimelockClient(
      {
        [idFor(0)]: 1n,
        [idFor(1)]: 1n,
        [idFor(2)]: 1n,
      },
      action.timelockAddress
    )

    expect(await pickTimelockSalt({ ...action, client: client as never })).toBe(
      saltFor(3)
    )
    expect(probedIds).toEqual([idFor(0), idFor(1), idFor(2), idFor(3)])
  })

  it('refuses on a PENDING operation rather than scheduling the batch twice', async () => {
    const { client } = fakeTimelockClient(
      { [idFor(0)]: 1_800_000_000n },
      action.timelockAddress
    )

    let thrown: unknown
    try {
      await pickTimelockSalt({ ...action, client: client as never })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/already scheduled/i)
    expect((thrown as Error).message).toMatch(/nothing was proposed/i)
  })

  it('refuses on a pending operation found after an executed one', async () => {
    // The normal state once a legitimate repeat has been scheduled, and the case
    // `attempt` exists for.
    const { client } = fakeTimelockClient(
      { [idFor(0)]: 1n, [idFor(1)]: 1_800_000_000n },
      action.timelockAddress
    )

    let thrown: unknown
    try {
      await pickTimelockSalt({ ...action, client: client as never })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/already scheduled/i)
  })

  it('rejects a payloads array whose length does not match the targets', async () => {
    const { client } = fakeTimelockClient({}, action.timelockAddress)

    let thrown: unknown
    try {
      await pickTimelockSalt({
        ...action,
        originalCalldatas: ['0xdeadbeef'],
        client: client as never,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/originalCalldatas/i)
  })

  it('rejects a values array whose length does not match the targets', async () => {
    const { client } = fakeTimelockClient({}, action.timelockAddress)

    let thrown: unknown
    try {
      await pickTimelockSalt({
        ...action,
        values: [0n],
        client: client as never,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/values/i)
  })

  it('refuses rather than guessing when every attempt is taken', async () => {
    const taken: Record<string, bigint> = {}
    for (let attempt = 0; attempt < 16; attempt++) taken[idFor(attempt)] = 1n
    const exhausted = fakeTimelockClient(taken, action.timelockAddress)
    const { probedIds } = exhausted

    let thrown: unknown
    try {
      await pickTimelockSalt({ ...action, client: exhausted.client as never })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/refusing to schedule/i)
    expect(probedIds).toHaveLength(16)
  })
})

/**
 * Drives `wrapWithTimelockSchedule` against a local JSON-RPC stub.
 *
 * The function builds its own client from `rpcUrl`, so pointing that at a stub
 * exercises the whole path without a chain — which is the only way to assert the
 * property the salt design rests on: the operation id probed is the operation the
 * emitted calldata actually schedules.
 */
describe('wrapWithTimelockSchedule', () => {
  const TIMELOCK = '0x1111111111111111111111111111111111111111' as Address
  const TARGETS = [
    '0x2222222222222222222222222222222222222222',
    '0x4444444444444444444444444444444444444444',
  ] as Address[]
  const PAYLOADS = ['0xdeadbeef', '0xfeedface'] as Hex[]

  const ZERO32 = `0x${'00'.repeat(32)}` as Hex

  interface IStub {
    url: string
    stop: () => void
    hashCalls: Hex[]
    getTimestampCalls: Hex[]
  }

  const startStub = async (): Promise<IStub> => {
    const hashCalls: Hex[] = []
    const getTimestampCalls: Hex[] = []
    // hashOperationBatch/getTimestamp/getMinDelay selectors, matched on the
    // 4-byte prefix so the stub does not need an ABI decoder.
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          id: number
          method: string
          params?: { data?: Hex }[]
        }
        const data = body.params?.[0]?.data ?? '0x'
        const selector = data.slice(0, 10)
        let result: Hex = ZERO32

        if (selector === '0xf27a0c92')
          result = `0x${(3600).toString(16).padStart(64, '0')}` as Hex
        else if (selector === '0xb1c5f427') {
          hashCalls.push(data)
          result = `0x${'11'.repeat(32)}` as Hex
        } else if (selector === '0xd45c4435') {
          getTimestampCalls.push(data)
          result = ZERO32
        }

        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      },
    })
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => {
        void server.stop(true)
      },
      hashCalls,
      getTimestampCalls,
    }
  }

  it('schedules the operation it probed, with one values array for both', async () => {
    const stub = await startStub()
    // `getViemChainForNetworkName` reads the network's RPC env var and throws
    // without it, so the test supplies its own stub URL rather than depending on
    // a populated .env — CI has none.
    const envKey = getRPCEnvVarName('mainnet')
    const previousRpc = process.env[envKey]
    process.env[envKey] = stub.url

    try {
      const { calldata, targetAddress } = await wrapWithTimelockSchedule(
        'mainnet',
        stub.url,
        TIMELOCK,
        TARGETS,
        PAYLOADS
      )

      expect(targetAddress).toBe(TIMELOCK)
      expect(stub.hashCalls).toHaveLength(1)

      const probed = decodeFunctionData({
        abi: TIMELOCK_OPERATION_STATE_ABI,
        data: stub.hashCalls[0] as Hex,
      })
      const scheduled = decodeFunctionData({
        abi: TIMELOCK_SCHEDULE_BATCH_ABI,
        data: calldata,
      })

      // targets, values, payloads and salt must match between the two, or the
      // state that was checked belongs to a different operation.
      expect(probed.args?.[0]).toEqual(scheduled.args?.[0])
      expect(probed.args?.[1]).toEqual(scheduled.args?.[1])
      expect(probed.args?.[2]).toEqual(scheduled.args?.[2])
      expect(probed.args?.[4]).toEqual(scheduled.args?.[4])

      // From the stub's getMinDelay, not the config-file or 1-hour fallback: a
      // delay below the timelock's real minDelay reverts after signing.
      expect(scheduled.args?.[5]).toBe(3600n)
    } finally {
      if (previousRpc === undefined) delete process.env[envKey]
      else process.env[envKey] = previousRpc
      stub.stop()
    }
  })
})
