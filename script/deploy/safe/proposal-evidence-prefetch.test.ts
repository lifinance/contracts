/**
 * Tests for ProposalEvidencePrefetchQueue (EXSC-712).
 *
 * The queue is exercised through injected `compute` / `resolveAnchor`
 * functions: what it has to get right — one proposal ahead and no more, a
 * prefetch used only under an anchor that still agrees, and a background throw
 * landing as a gradeable value rather than as nothing — is independent of what
 * the evidence itself is.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  createDeferredLogger,
  ProposalEvidencePrefetchQueue,
} from './confirm-safe-tx-prefetch'

const FAILED = { failed: true } as const
type Evidence = { id: string } | typeof FAILED

const makeQueue = (): ProposalEvidencePrefetchQueue<string, Evidence> =>
  new ProposalEvidencePrefetchQueue<string, Evidence>(() => FAILED)

const anchorOf =
  (...reads: string[]) =>
  (): Promise<string | undefined> =>
    Promise.resolve(reads.length > 1 ? (reads.shift() as string) : reads[0])

/** A `compute` that records how often it ran. */
const counted = (id: string) => {
  const state = { runs: 0 }
  return {
    state,
    compute: async (): Promise<Evidence> => {
      state.runs++
      return { id }
    },
  }
}

describe('a scheduled proposal is served from the prefetch', () => {
  it('does not recompute when the anchor still agrees', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('b', compute, anchorOf('0:7'))
    const taken = await queue.take('b', compute, anchorOf('0:7'))

    expect(taken.value).toEqual({ id: 'b' })
    expect(taken.prefetched).toBe(true)
    expect(taken.discarded).toBeUndefined()
    expect(state.runs).toBe(1)
  })

  it('computes inline when nothing was scheduled for that proposal', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('a', async () => ({ id: 'a' }), anchorOf('0:7'))
    const taken = await queue.take('b', compute, anchorOf('0:7'))

    expect(taken.value).toEqual({ id: 'b' })
    expect(taken.prefetched).toBe(false)
    expect(state.runs).toBe(1)
  })

  it('consumes the slot, so the same key is not served twice', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('b', compute, anchorOf('0:7'))
    await queue.take('b', compute, anchorOf('0:7'))
    const second = await queue.take('b', compute, anchorOf('0:7'))

    expect(second.prefetched).toBe(false)
    expect(state.runs).toBe(2)
  })

  it('holds one proposal at a time, so a second schedule replaces the first', async () => {
    const queue = makeQueue()
    const first = counted('a')

    queue.schedule('a', first.compute, anchorOf('0:7'))
    queue.schedule('b', async () => ({ id: 'b' }), anchorOf('0:7'))
    const taken = await queue.take('a', first.compute, anchorOf('0:7'))

    // 'a' was evicted by 'b', so taking it recomputes rather than reaching
    // into a deeper queue. Depth stays at the one human-read interval.
    expect(taken.prefetched).toBe(false)
    expect(first.state.runs).toBe(2)
  })
})

describe('a prefetch is discarded rather than presented as current', () => {
  it('recomputes when the anchor moved while the prefetch sat unused', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('b', compute, anchorOf('0:7'))
    const taken = await queue.take('b', compute, anchorOf('1:8'))

    expect(taken.prefetched).toBe(false)
    expect(taken.discarded).toContain('0:7 → 1:8')
    expect(state.runs).toBe(2)
  })

  it('recomputes when the anchor cannot be re-read', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('b', compute, anchorOf('0:7'))
    const taken = await queue.take('b', compute, async () => undefined)

    expect(taken.prefetched).toBe(false)
    expect(taken.discarded).toContain('could not be re-read')
    expect(state.runs).toBe(2)
  })

  it('recomputes when the anchor could not be read before the prefetch ran', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('b', compute, async () => undefined)
    const taken = await queue.take('b', compute, anchorOf('0:7'))

    expect(taken.prefetched).toBe(false)
    expect(state.runs).toBe(2)
    // The reason, not just the recompute. Without it this test passes with the
    // `preparedAnchor === undefined` branch deleted — an unset anchor compares
    // unequal to any string, so the discard happens either way and only the
    // diagnosis is lost. Asserting the message is what makes the branch covered.
    expect(taken.discarded).toContain('could not record what state it read')
  })

  it('recomputes when re-reading the anchor throws', async () => {
    const queue = makeQueue()
    const { state, compute } = counted('b')

    queue.schedule('b', compute, anchorOf('0:7'))
    const taken = await queue.take('b', compute, async () => {
      throw new Error('rpc down')
    })

    expect(taken.prefetched).toBe(false)
    expect(state.runs).toBe(2)
  })
})

describe('a background failure is a value, never a missing one', () => {
  it('does not reject, and retries inline before falling back', async () => {
    const queue = makeQueue()
    let attempts = 0
    const compute = async (): Promise<Evidence> => {
      attempts++
      throw new Error('rpc exploded')
    }

    queue.schedule('b', compute, anchorOf('0:7'))
    const taken = await queue.take('b', compute, anchorOf('0:7'))

    // Retried inline — a failure captured minutes ago may be a blip that has
    // since cleared, and without a prefetch the read would have run now.
    expect(attempts).toBe(2)
    expect(taken.value).toBe(FAILED)
    expect(taken.prefetched).toBe(false)
  })

  it('falls back when the inline computation throws too', async () => {
    const queue = makeQueue()
    const taken = await queue.take(
      'b',
      async () => {
        throw new Error('still down')
      },
      anchorOf('0:7')
    )

    expect(taken.value).toBe(FAILED)
  })
})

describe('the prefetch writes to a deferred console', () => {
  it('keeps the lines in order instead of printing them', () => {
    const logger = createDeferredLogger()

    logger.info('first')
    logger.warn('second')
    logger.error('third')

    expect(logger.lines).toEqual([
      { level: 'info', message: 'first' },
      { level: 'warn', message: 'second' },
      { level: 'error', message: 'third' },
    ])
  })
})

/**
 * How the queue is wired into `confirm-safe-tx.ts`.
 *
 * Source-asserted for the same reason the other placement guards in this
 * directory are: the script calls `runMain` at module scope and reaching its
 * loop needs MongoDB, a Safe and a Ledger, so the wiring cannot be driven. The
 * queue's own behaviour is driven above; what that cannot see is what the run
 * anchors a prefetch on, and whether the anchor still moves.
 */
describe('the queue is wired to something that actually moves', () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, 'confirm-safe-tx.ts'),
    'utf8'
  )

  it("anchors on the Safe nonce and on the run's own broadcasts", () => {
    // Assembled rather than written out: the literal is a template string, and
    // spelling it inline here is a lint error in this repo.
    const anchor = [
      '`$',
      '{broadcastsMade}:$',
      '{await safe.getNonce()}`',
    ].join('')
    expect(SOURCE).toContain(anchor)

    // The bump must be unconditional and adjacent to the call that puts the
    // transaction on the wire: a broadcast that throws may still have reached
    // the chain, and a prefetch taken against the state before it is stale
    // either way. An anchor wired to a counter nothing increments matches
    // forever, which is the same as having no anchor at all.
    //
    // Matched as the two statements together rather than as two positions in
    // the file. An ordering assertion over `indexOf` is satisfied by a bump
    // that never runs — `if (false) broadcastsMade++` sits at a lower index
    // just the same — and that mutation was left green by the version of this
    // test that only compared positions.
    expect(SOURCE).toMatch(
      /\n +broadcastsMade\+\+\n +const exec = await safeClient\.executeTransaction\(/u
    )

    // One route to the wire, so the statement above covers every broadcast this
    // run makes. A second call site would be a second route, bumping nothing.
    expect([
      ...SOURCE.matchAll(/safeClient\.executeTransaction\(/gu),
    ]).toHaveLength(1)
  })

  it('prepares and re-validates against the same anchor', () => {
    // One resolver reaching both call sites — the schedule and the take — by
    // being the same identifier passed to each. A prefetch prepared under one
    // anchor and checked against another would agree by accident or never agree
    // at all.
    //
    // Asserted as the two call shapes rather than as a count of the name: a
    // bare occurrence count is satisfied by any mention and breaks on
    // reformatting, which makes it fail for reasons that are not this one.
    expect(SOURCE).toMatch(
      /evidencePrefetch\.take\(\s*tx,\s*\(\) => computeProposalEvidence\(tx\),\s*resolveEvidenceAnchor\s*\)/u
    )
    expect(SOURCE).toMatch(
      /evidencePrefetch\.schedule\(\s*nextTx,\s*\(\) => computeProposalEvidence\(nextTx\),\s*resolveEvidenceAnchor\s*\)/u
    )
  })

  it('writes no line to the terminal from inside the evidence function', () => {
    const start = SOURCE.indexOf('async function computeProposalEvidence(')
    expect(start).toBeGreaterThan(-1)
    const end = SOURCE.indexOf('\n  }\n', SOURCE.indexOf('lines: log.lines,'))
    expect(end).toBeGreaterThan(start)

    const body = SOURCE.slice(start, end)

    // Controls, because a shrunken window satisfies the negative below while
    // covering none of the reads it is about.
    for (const read of [
      'evaluateCodehashSignGate',
      'runIntegrityAsserts',
      'collectExecutabilityInput',
      'collectProviderObservations',
      'observeSetForProposal',
    ])
      expect(body).toContain(read)

    // Everything this function itself says is carried on the bundle and
    // printed when the proposal it belongs to is displayed. A direct `consola`
    // call here prints the next proposal's warning under this one's verdicts,
    // where it reads as being about the proposal on screen.
    //
    // Scope, stated because the assertion cannot express it: this covers the
    // function's own writes, not those of the shared helpers it calls.
    // `getFallbackTransportForChain` warns about unusable endpoints on its own
    // console, and `SafeClient.getNonce` logs before it rethrows — so a
    // prefetch can still print through them. Those helpers have call sites
    // outside this run and threading a sink through them is a wider change than
    // this one.
    expect(body).not.toContain('consola.')
  })

  it('falls back to a bundle every check can still be graded from', () => {
    expect(SOURCE).toContain('unreadableEvidence(error)')
    expect(SOURCE).toContain('new ProposalEvidencePrefetchQueue<')
  })
})
