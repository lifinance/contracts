/**
 * Tests for the signer-facing provenance block (EXSC-693).
 *
 * The properties that matter are the ones a signer relies on: a legacy row
 * without provenance still renders (and says so), a dirty tree or an unpushed
 * commit is impossible to miss, and a partially written document cannot throw
 * in the middle of a signing session.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { formatProvenanceLines } from './provenance-display'
import type { IProposalProvenance } from './safe-utils'

const SHA = '1234567890abcdef1234567890abcdef12345678'

// ESC assembled from its code point, so the pattern holds no control character.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'gu')

/** Renders the block as plain text so assertions ignore ANSI colouring. */
function render(provenance?: IProposalProvenance): string {
  return formatProvenanceLines(provenance).join('\n').replace(ANSI_PATTERN, '')
}

function buildProvenance(
  overrides: Partial<IProposalProvenance> = {}
): IProposalProvenance {
  return {
    actor: 'human',
    proposerHandle: 'Alice Example <alice@example.com>',
    gitCommit: SHA,
    gitBranch: 'feat/exsc-692',
    dirtyTreeScoped: [],
    commitOnRemote: true,
    capturedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  }
}

describe('formatProvenanceLines — legacy rows', () => {
  it('renders one explicit line when there is no provenance', () => {
    const lines = formatProvenanceLines(undefined)

    expect(lines).toHaveLength(1)
    expect(render(undefined)).toBe(
      '    Provenance:      — not recorded (proposal predates provenance capture) —'
    )
  })
})

describe('formatProvenanceLines — a healthy proposal', () => {
  it('shows proposer, short commit, branch, PR and reason', () => {
    const text = render(
      buildProvenance({
        prUrl: 'https://github.com/lifinance/contracts/pull/2125',
        reason: 'add AcrossFacetV4 to the whitelist',
      })
    )

    expect(text).toBe(
      [
        '    Proposed by:     Alice Example <alice@example.com> (human)',
        '    Source:          1234567890ab @ feat/exsc-692',
        '    Working tree:    clean',
        '    PR:              https://github.com/lifinance/contracts/pull/2125',
        '    Reason:          add AcrossFacetV4 to the whitelist',
      ].join('\n')
    )
  })

  it('omits the PR line when no PR was resolved', () => {
    expect(render(buildProvenance())).not.toContain('PR:')
  })

  it('flags a missing reason instead of leaving the line blank', () => {
    expect(render(buildProvenance())).toContain(
      'Reason:          — none given —'
    )
  })
})

describe('formatProvenanceLines — states that should stop a signer', () => {
  it('marks a dirty tree with a count and the first three paths', () => {
    const text = render(
      buildProvenance({
        dirtyTreeScoped: [
          'config/whitelist.json',
          'src/Facets/A.sol',
          'src/Facets/B.sol',
          'src/Facets/C.sol',
        ],
      })
    )

    expect(text).toContain(
      'Working tree:    ⚠ 4 dirty: config/whitelist.json, src/Facets/A.sol, src/Facets/B.sol, …'
    )
  })

  it('does not elide a dirty list that fits', () => {
    const text = render(
      buildProvenance({ dirtyTreeScoped: ['config/whitelist.json'] })
    )

    expect(text).toContain('Working tree:    ⚠ 1 dirty: config/whitelist.json')
    expect(text).not.toContain('…')
  })

  it('marks a truncated dirty list as a lower bound', () => {
    const text = render(
      buildProvenance({
        dirtyTreeScoped: ['a.sol', 'b.sol', 'c.sol'],
        dirtyTreeTruncated: true,
      })
    )

    expect(text).toContain('⚠ 3+ dirty: a.sol, b.sol, c.sol, …')
  })

  it('marks a commit that is not on any remote', () => {
    expect(render(buildProvenance({ commitOnRemote: false }))).toContain(
      '✗ NOT PUSHED (per local refs)'
    )
  })

  it('says so when the push state could not be determined', () => {
    expect(render(buildProvenance({ commitOnRemote: undefined }))).toContain(
      '(push state unknown)'
    )
  })

  it('stays quiet about push state for a pushed commit', () => {
    const text = render(buildProvenance())

    expect(text).not.toContain('NOT PUSHED')
    expect(text).not.toContain('push state unknown')
  })

  it('surfaces capture errors so sentinel values are explainable', () => {
    const text = render(
      buildProvenance({
        gitCommit: 'unknown',
        captureErrors: ['git rev-parse HEAD failed: exit 128', 'and another'],
      })
    )

    expect(text).toContain('Source:          unknown @ feat/exsc-692')
    expect(text).toContain(
      'Capture:         ⚠ incomplete (2): git rev-parse HEAD failed: exit 128'
    )
  })
})

describe('formatProvenanceLines — malformed rows', () => {
  it('does not throw when dirtyTreeScoped is missing', () => {
    const malformed = buildProvenance()
    delete (malformed as unknown as Record<string, unknown>).dirtyTreeScoped

    expect(() => formatProvenanceLines(malformed)).not.toThrow()
    expect(render(malformed)).toContain('Working tree:    clean')
  })

  it('falls back to unknown for every missing string field', () => {
    const malformed = { capturedAt: '' } as unknown as IProposalProvenance

    const text = render(malformed)

    expect(text).toContain('Proposed by:     unknown (unknown)')
    expect(text).toContain('Source:          unknown @ unknown')
  })
})

// Provenance strings are proposer-supplied and land in the prompt a human reads
// before signing, so terminal control characters must not survive rendering:
// they can erase or repaint the surrounding lines. The assertions strip only
// the module's own colour codes, then require that nothing controlling is left.
describe('formatProvenanceLines — untrusted text cannot repaint the prompt', () => {
  const ESC = String.fromCharCode(27)
  const CR = String.fromCharCode(13)
  const NUL = String.fromCharCode(0)
  const C1_CSI = String.fromCharCode(0x9b)
  const CONTROL = /\p{Cc}/u

  // Joined with a space, not a newline: the separator itself must not be a
  // control character, or the Cc assertion below would always match.
  /** Drops the colour codes this module emits itself, keeping injected ones. */
  const plain = (lines: string[]): string =>
    lines.join(' ').replace(ANSI_PATTERN, '')

  it('renders an escape sequence and a carriage return inert in the reason', () => {
    const text = plain(
      formatProvenanceLines(
        buildProvenance({
          reason: `benign${ESC}[2J${ESC}[1;32m APPROVED BY SECURITY${CR}Reason: benign`,
        })
      )
    )

    expect(CONTROL.test(text)).toBe(false)
    expect(text).toContain('benign[2J[1;32m APPROVED BY SECURITYReason: benign')
  })

  it('strips control characters from every proposer-influenced field', () => {
    const poisoned = `x${ESC}[2J${CR}${NUL}${C1_CSI}y`

    const text = plain(
      formatProvenanceLines(
        buildProvenance({
          proposerHandle: poisoned,
          gitBranch: poisoned,
          dirtyTreeScoped: [poisoned],
          prUrl: poisoned,
          reason: poisoned,
          captureErrors: [poisoned],
        })
      )
    )

    expect(CONTROL.test(text)).toBe(false)
  })

  it('leaves legitimate unicode in provenance text untouched', () => {
    const text = plain(
      formatProvenanceLines(
        buildProvenance({ reason: 'déployer 日本語 — naïve 👨‍👩‍👧' })
      )
    )

    expect(text).toContain('déployer 日本語 — naïve 👨‍👩‍👧')
  })
})
