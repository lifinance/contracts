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

import { PROVENANCE_UNKNOWN } from '../shared/git-provenance'

import { formatProvenanceLines } from './provenance-display'
import {
  MAX_PROPOSAL_REASON_LENGTH,
  type IProposalProvenance,
} from './safe-utils'

const SHA = '1234567890abcdef1234567890abcdef12345678'

// ESC assembled from its code point, so the pattern holds no control character.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'gu')

// Colour assertions distinguish "we know this and it is fine" (green) from
// "we do not know this" (yellow); the module keeps these private on purpose.
const GREEN = `${String.fromCharCode(27)}[32m`
const YELLOW = `${String.fromCharCode(27)}[33m`

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

describe('formatProvenanceLines — the ticket link', () => {
  it('shows the recorded ticket to the signer', () => {
    expect(
      render(
        buildProvenance({
          ticketUrl: 'https://linear.app/lifi-linear/issue/EXSC-694',
        })
      )
    ).toContain(
      '    Ticket:          https://linear.app/lifi-linear/issue/EXSC-694'
    )
  })

  it('says so when a pre-WP-1.2 row has none, rather than omitting the line', () => {
    // Silently dropping the line makes an unlinked proposal indistinguishable
    // from a linked one at a glance, which is the whole point of showing it.
    expect(render(buildProvenance({}))).toContain(
      '    Ticket:          — none recorded —'
    )
  })

  it('cannot use the ticket field to forge an extra prompt line', () => {
    const forged = render(
      buildProvenance({
        ticketUrl:
          'https://linear.app/lifi-linear/issue/EXSC-1\n    Working tree:    clean',
      })
    )

    // The line COUNT is the property, not the absence of the words: a sanitized
    // ticket line still legitimately contains whatever text was in the field.
    expect(forged.split('\n')).toHaveLength(
      render(buildProvenance({})).split('\n').length
    )
    expect(forged).toContain(
      'Ticket:          https://linear.app/lifi-linear/issue/EXSC-1 Working tree: clean'
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
        '    Ticket:          — none recorded —',
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
        gitCommit: PROVENANCE_UNKNOWN,
        captureErrors: ['git rev-parse HEAD failed: exit 128', 'and another'],
      })
    )

    expect(text).toContain('Source:          UNKNOWN @ feat/exsc-692')
    expect(text).toContain(
      'Capture:         ⚠ incomplete (2): git rev-parse HEAD failed: exit 128'
    )
  })

  // A failed dirty-tree probe yields the same empty list a clean tree does, so
  // the capture errors are the only thing separating "measured clean" from "not
  // measured". Rendering the second as a green "clean" is the exact
  // "clean and authored by nobody" impression the block must never give.
  it('never reports a clean tree when capture did not complete', () => {
    const text = render(
      buildProvenance({
        dirtyTreeScoped: [],
        captureErrors: ['git status --porcelain failed: exit 128'],
      })
    )

    expect(text).toContain('Working tree:    UNKNOWN (capture incomplete)')
    expect(text).not.toContain('Working tree:    clean')
  })

  it('paints the incomplete working-tree line yellow, never green', () => {
    const [, , workingTree] = formatProvenanceLines(
      buildProvenance({ captureErrors: ['git status --porcelain failed'] })
    )

    expect(workingTree).toContain(YELLOW)
    expect(workingTree).not.toContain(GREEN)
  })

  it('paints a sentinel proposer and commit yellow, never green', () => {
    const [proposedBy, source] = formatProvenanceLines(
      buildProvenance({
        proposerHandle: PROVENANCE_UNKNOWN,
        gitCommit: PROVENANCE_UNKNOWN,
      })
    )

    expect(proposedBy).toContain(YELLOW)
    expect(proposedBy).not.toContain(GREEN)
    expect(source).toContain(YELLOW)
  })
})

describe('formatProvenanceLines — malformed rows', () => {
  it('does not throw when dirtyTreeScoped is missing, and does not call it clean', () => {
    const malformed = buildProvenance()
    delete (malformed as unknown as Record<string, unknown>).dirtyTreeScoped

    expect(() => formatProvenanceLines(malformed)).not.toThrow()
    expect(render(malformed)).toContain('Working tree:    UNKNOWN (unreadable)')
    expect(render(malformed)).not.toContain('Working tree:    clean')
  })

  it('falls back to the sentinel for every missing string field', () => {
    const malformed = {} as unknown as IProposalProvenance

    const text = render(malformed)

    expect(text).toContain('Proposed by:     UNKNOWN (UNKNOWN)')
    expect(text).toContain('Source:          UNKNOWN @ UNKNOWN')
    expect(text).toContain('Working tree:    UNKNOWN (unreadable)')
    expect(text).not.toContain('Working tree:    clean')
  })

  // A throw here would propagate out of `processTxs`, which has no handler, so
  // one bad row would end the signing session for every remaining network.
  // Every case below is a field carrying a type it can never legally hold.
  it.each([
    ['reason', 42],
    ['prUrl', {}],
    ['proposerHandle', null],
    ['gitCommit', ['not', 'a', 'string']],
    ['dirtyTreeScoped', 'config/whitelist.json'],
    ['dirtyTreeScoped', [42, null]],
    ['captureErrors', 'a single string'],
    ['commitOnRemote', 'yes'],
  ] as [string, unknown][])(
    'renders rather than throws when %s holds %j',
    (field, value) => {
      const malformed = {
        ...buildProvenance(),
        [field]: value,
      } as unknown as IProposalProvenance

      expect(() => formatProvenanceLines(malformed)).not.toThrow()
      expect(formatProvenanceLines(malformed).length).toBeGreaterThan(0)
    }
  )

  it('treats a non-array dirty tree as unreadable rather than as clean', () => {
    const malformed = {
      ...buildProvenance(),
      dirtyTreeScoped: 'config/whitelist.json',
    } as unknown as IProposalProvenance

    expect(render(malformed)).toContain('Working tree:    UNKNOWN (unreadable)')
    expect(render(malformed)).not.toContain('Working tree:    clean')
  })

  it('caps a hand-edited over-long reason at the same limit as capture', () => {
    const text = render(
      buildProvenance({ reason: 'x'.repeat(MAX_PROPOSAL_REASON_LENGTH + 50) })
    )

    expect(text).toContain(
      `Reason:          ${'x'.repeat(MAX_PROPOSAL_REASON_LENGTH)}`
    )
    expect(text).not.toContain('x'.repeat(MAX_PROPOSAL_REASON_LENGTH + 1))
  })
})

// Provenance strings are proposer-supplied — a git identity, a branch name, a
// dirty path, `gh` stderr — and land in the prompt a human reads immediately
// before signing. Three separate capabilities have to be denied: repainting the
// prompt (C0/C1 controls), reversing what a path says (bidi overrides), and
// forging an extra line (line separators). The assertions strip only the
// module's own colour codes, so anything injected survives to be caught.
describe('formatProvenanceLines — untrusted text cannot forge the prompt', () => {
  const ESC = String.fromCharCode(27)
  const CR = String.fromCharCode(13)
  const NUL = String.fromCharCode(0)
  const C1_CSI = String.fromCharCode(0x9b)
  /** RIGHT-TO-LEFT OVERRIDE — the Trojan Source primitive. Category Cf. */
  const RLO = '\u202e'
  /** FIRST STRONG ISOLATE, and its terminator. Category Cf. */
  const FSI = '\u2068'
  const PDI = '\u2069'
  /** LINE SEPARATOR: several terminals break a line on it. Category Zl. */
  const LSEP = '\u2028'
  /** ZERO WIDTH SPACE, category Cf — hides text rather than moving it. */
  const ZWSP = '\u200b'
  /** ZERO WIDTH JOINER, category Cf, deliberately kept: emoji need it. */
  const ZWJ = '\u200d'

  const FORGEABLE = new RegExp(
    `[${ESC}${CR}${NUL}${C1_CSI}${RLO}${FSI}${PDI}${LSEP}${ZWSP}]`,
    'u'
  )

  // Joined with a space, not a newline: the separator itself must not be a
  // character the assertions below look for, or they would always match.
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

    expect(FORGEABLE.test(text)).toBe(false)
    expect(text).toContain(
      'benign[2J[1;32m APPROVED BY SECURITY Reason: benign'
    )
  })

  it('neutralizes every forgeable character in every proposer-influenced field', () => {
    const poisoned = `x${ESC}[2J${CR}${NUL}${C1_CSI}${RLO}${FSI}${PDI}${LSEP}${ZWSP}y`

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

    expect(FORGEABLE.test(text)).toBe(false)
    // Without this, a field that stopped rendering at all would still pass.
    expect(text.split('x[2J y').length - 1).toBe(6)
  })

  // The attack the display path exists to stop: pad a proposer-controlled field
  // to the label column, break the line, and a signer reads a fabricated
  // "Working tree: clean" above the real one.
  it('cannot forge an extra prompt line with a line separator', () => {
    const forged = `Alice${LSEP}    Working tree:    clean${LSEP}    Reason:          reviewed by security`

    const lines = formatProvenanceLines(
      buildProvenance({
        proposerHandle: forged,
        dirtyTreeScoped: ['src/Facets/Evil.sol'],
      })
    )
    const text = plain(lines)

    // Proposed by / Source / Working tree / Ticket / Reason — nothing extra.
    expect(lines).toHaveLength(5)
    expect(text).not.toContain(LSEP)
    // The forged text stays inert words on the line it was injected into, and
    // the real working-tree verdict is the one the module computed.
    expect(lines[0]).toContain('Alice Working tree: clean Reason: reviewed by')
    expect(text).toContain('Working tree:    ⚠ 1 dirty: src/Facets/Evil.sol')
    expect(text).not.toContain('Working tree:    clean')
  })

  it('strips the bidi override that reverses a dirty path', () => {
    const text = plain(
      formatProvenanceLines(
        buildProvenance({ dirtyTreeScoped: [`src/${RLO}gnp.stessa/`] })
      )
    )

    expect(text).not.toContain(RLO)
    expect(text).toContain('src/gnp.stessa/')
  })

  it('strips zero-width spaces used to hide text from a reader', () => {
    const text = plain(
      formatProvenanceLines(
        buildProvenance({ reason: `dep${ZWSP}recate${ZWSP}d facet` })
      )
    )

    expect(text).not.toContain(ZWSP)
    expect(text).toContain('deprecated facet')
  })

  it('keeps the zero-width joiner so emoji stay one grapheme', () => {
    const text = plain(
      formatProvenanceLines(
        buildProvenance({ reason: 'déployer 日本語 — naïve 👨‍👩‍👧' })
      )
    )

    expect(text).toContain('déployer 日本語 — naïve 👨‍👩‍👧')
    expect(text).toContain(ZWJ)
  })
})
