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

    // The counter has to be bumped, and bumped before the call that puts the
    // transaction on the wire: a broadcast that throws may still have reached
    // the chain, and a prefetch taken against the state before it is stale
    // either way. An anchor wired to a counter nothing increments matches
    // forever, which is the same as having no anchor at all.
    const bumped = SOURCE.indexOf('broadcastsMade++')
    const broadcast = SOURCE.indexOf('safeClient.executeTransaction(')

    expect(bumped).toBeGreaterThan(-1)
    expect(broadcast).toBeGreaterThan(bumped)
  })

  it('prepares and re-validates against the same anchor', () => {
    // Two call sites, one resolver. A prefetch prepared under one anchor and
    // checked against another would agree by accident or never agree at all.
    expect([
      ...SOURCE.matchAll(/resolveEvidenceAnchor\s*\n?\s*\)/gu),
    ]).toHaveLength(2)
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

    // Everything the reads say is carried on the bundle and printed when the
    // proposal it belongs to is displayed. A direct `consola` call here prints
    // the next proposal's warning under this one's verdicts, where it reads as
    // being about the proposal on screen.
    expect(body).not.toContain('consola.')
  })

  it('falls back to a bundle every check can still be graded from', () => {
    expect(SOURCE).toContain('unreadableEvidence(error)')
    expect(SOURCE).toContain('new ProposalEvidencePrefetchQueue<')
  })
})
