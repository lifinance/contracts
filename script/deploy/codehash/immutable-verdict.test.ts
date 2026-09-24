/**
 * Gate L's grading, which is the half a codehash comparison cannot reach.
 *
 * The property that matters most is the asymmetry between the two chains: a
 * value that DISAGREES blocks wherever it was read, while a value that agrees
 * under a slot ordering nobody confirmed is the one thing a signer may take on.
 * Collapsing those would hand the acknowledgement path to a tampered value.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IGradedImmutable } from './immutable-expectations'
import {
  gradeAssumedImmutables,
  gradeInlinedImmutables,
  noImmutables,
  type IOffCodeImmutables,
} from './immutable-verdict'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const DECLARED = `0x${'00'.repeat(12)}${'22'.repeat(20)}`
const OTHER = `0x${'00'.repeat(12)}${'33'.repeat(20)}`

const slot = (over: Partial<IGradedImmutable> = {}): IGradedImmutable => ({
  name: 'gasZipRouter',
  status: 'verified',
  byteCount: 32,
  observed: DECLARED,
  expected: DECLARED,
  origin: 'config/networks.json.zksync.gasZip',
  ...over,
})

const priced = (
  slots: IGradedImmutable[],
  over: { unpricedByteCount?: number; acknowledgeableByteCount?: number } = {}
) => ({
  decided: true as const,
  slots,
  disagreements: slots.filter((one) => one.status === 'disagrees'),
  pricedByteCount: 32,
  unpricedByteCount: 0,
  acknowledgeableByteCount: 0,
  disagreeingByteCount: 0,
  ...over,
})

describe('gradeInlinedImmutables', () => {
  it('verifies a contract whose every slot holds what config declares', () => {
    const verdict = gradeInlinedImmutables(ADDRESS, 'mainnet', priced([slot()]))

    expect(verdict.status).toBe('verified')
    expect(verdict.detail).toContain('gasZipRouter')
  })

  it('reports a disagreement with both values on the line', () => {
    const verdict = gradeInlinedImmutables(
      ADDRESS,
      'mainnet',
      priced([slot({ status: 'disagrees', observed: OTHER })])
    )

    expect(verdict.status).toBe('disagrees')
    expect(verdict.detail).toContain(OTHER)
    expect(verdict.detail).toContain(DECLARED)
  })

  it('does not report a slot with no expectation as verified', () => {
    const verdict = gradeInlinedImmutables(
      ADDRESS,
      'mainnet',
      priced(
        [slot({ status: 'undeclared', detail: 'has no registry entry' })],
        { unpricedByteCount: 32 }
      )
    )

    expect(verdict.status).toBe('unpriced')
    expect(verdict.detail).toContain('no registry entry')
  })

  it('grades a gap the registry states in writing as documented, not unpriced', () => {
    const verdict = gradeInlinedImmutables(
      ADDRESS,
      'mainnet',
      priced(
        [
          slot(),
          slot({
            status: 'acknowledgeable',
            detail: 'is unverifiable: read from the deployment log',
          }),
        ],
        { acknowledgeableByteCount: 32 }
      )
    )

    expect(verdict.status).toBe('documented')
    expect(verdict.detail).toContain('deployment log')
  })

  it('keeps an unnoticed gap blocking even beside a stated one', () => {
    // The two must not average: an acknowledgement offered here would have a
    // signer take on the one slot nobody wrote anything about.
    const verdict = gradeInlinedImmutables(
      ADDRESS,
      'mainnet',
      priced(
        [
          slot({ status: 'undeclared', detail: 'has no registry entry' }),
          slot({
            status: 'acknowledgeable',
            detail: 'is unverifiable: a reason',
          }),
        ],
        { unpricedByteCount: 32, acknowledgeableByteCount: 32 }
      )
    )

    expect(verdict.status).toBe('unpriced')
  })

  it('carries a refusal through as unreadable, never as a finding', () => {
    const verdict = gradeInlinedImmutables(ADDRESS, 'mainnet', {
      decided: false,
      reason: 'the record carries no commit',
    })

    expect(verdict.status).toBe('unreadable')
    expect(verdict.detail).toContain('no commit')
  })
})

describe('gradeAssumedImmutables', () => {
  const read = (pricing: IOffCodeImmutables): IOffCodeImmutables => pricing

  it('grades agreement as assumed, and says what the assumption is', () => {
    const verdict = gradeAssumedImmutables(
      ADDRESS,
      'zksync',
      read({
        declared: 'some',
        pricing: priced([slot()]),
        slotByName: { gasZipRouter: 0 },
      })
    )

    expect(verdict.status).toBe('assumed')
    expect(verdict.detail).toContain('slot 0 gasZipRouter')
    expect(verdict.detail).toContain('the order the contract declares them in')
  })

  const ZERO = `0x${'00'.repeat(32)}`

  it('refuses when every slot read zero, which is what an address holding no immutables also returns', async () => {
    // `ImmutableSimulator.getImmutable` reverts for nothing: a dead EOA and an
    // out-of-range index both answer zero. Verified against live zksync.
    const verdict = gradeAssumedImmutables(
      ADDRESS,
      'zksync',
      read({
        declared: 'some',
        pricing: priced([
          slot({ observed: ZERO, expected: ZERO }),
          slot({ name: 'other', observed: ZERO, expected: ZERO }),
        ]),
        slotByName: { gasZipRouter: 0, other: 32 },
      })
    )

    expect(verdict.status).toBe('unreadable')
    expect(verdict.detail).toMatch(/zero/iu)
  })

  it('does not offer a zero-valued slot as confirmed, even beside a corroborating one', () => {
    // A non-zero slot proves the address registered immutables, so the mapping
    // is corroborated — but a zero slot still holds the one value that carries
    // no evidence of its own, so it must not read as checked.
    const verdict = gradeAssumedImmutables(
      ADDRESS,
      'zksync',
      read({
        declared: 'some',
        pricing: priced([
          slot(),
          slot({ name: 'unset', observed: ZERO, expected: ZERO }),
        ]),
        slotByName: { gasZipRouter: 0, unset: 32 },
      })
    )

    expect(verdict.status).toBe('assumed')
    expect(verdict.detail).toMatch(/unset[^.]*not confirmed|unset.*zero/iu)
  })

  it('hard-blocks a disagreement rather than offering it for acknowledgement', () => {
    // The whole point of the split: only the undecidable mapping is
    // acknowledgeable, and a value read and found different is not that.
    const verdict = gradeAssumedImmutables(
      ADDRESS,
      'zksync',
      read({
        declared: 'some',
        pricing: priced([slot({ status: 'disagrees', observed: OTHER })]),
        slotByName: { gasZipRouter: 0 },
      })
    )

    expect(verdict.status).toBe('disagrees')
  })

  it('blocks a slot with no registry entry, as the inlined path does', () => {
    const verdict = gradeAssumedImmutables(
      ADDRESS,
      'zksync',
      read({
        declared: 'some',
        pricing: priced(
          [slot({ status: 'undeclared', detail: 'has no registry entry' })],
          { unpricedByteCount: 32 }
        ),
        slotByName: { gasZipRouter: 0 },
      })
    )

    expect(verdict.status).toBe('unpriced')
    expect(verdict.detail).toContain('slot 0 gasZipRouter')
    expect(verdict.detail).toContain('unchecked')
  })

  it('still offers a documented gap for acknowledgement', () => {
    const verdict = gradeAssumedImmutables(
      ADDRESS,
      'zksync',
      read({
        declared: 'some',
        pricing: priced(
          [
            slot(),
            slot({
              name: 'derived',
              status: 'acknowledgeable',
              observed: OTHER,
              detail: 'derived at deploy time',
            }),
          ],
          { acknowledgeableByteCount: 32 }
        ),
        slotByName: { gasZipRouter: 0, derived: 32 },
      })
    )

    expect(verdict.status).toBe('assumed')
  })

  it('reports a contract declaring no immutables as nothing to grade', () => {
    const verdict = gradeAssumedImmutables(ADDRESS, 'zksync', {
      declared: 'none',
    })

    expect(verdict).toEqual(noImmutables(ADDRESS))
  })

  it('carries a refused read through as unreadable', () => {
    const verdict = gradeAssumedImmutables(ADDRESS, 'zksync', {
      declared: 'some',
      pricing: { decided: false, reason: 'the simulator could not be read' },
      slotByName: {},
    })

    expect(verdict.status).toBe('unreadable')
  })
})
