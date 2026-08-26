/**
 * Proposal provenance display
 *
 * Renders the provenance block of a Safe proposal as detail lines for the
 * signing prompt. Import from `confirm-safe-tx.ts` so a signer can see which
 * code produced the proposal, and whether that code is fetchable and matches a
 * clean tree, without leaving the CLI.
 */

import {
  PROVENANCE_UNKNOWN,
  sanitizeProvenanceText,
} from '../shared/git-provenance'

import type { IProposalProvenance } from './safe-utils'

/** Dirty paths named inline before the list is elided. */
const DIRTY_PATHS_SHOWN = 3
/** Width of the label column used by every line in the signing prompt. */
const LABEL_WIDTH = 17

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'

const color = (code: string, text: string): string => `${code}${text}${RESET}`

/**
 * Reduces one proposer-supplied field to a single printable line.
 *
 * Everything this module renders is read by a human immediately before they
 * approve a transaction, so text carrying escape sequences, bidi overrides or
 * line separators could repaint, reverse or fabricate the lines around it.
 * `sanitizeProvenanceText` documents the exact classes removed; it also coerces
 * non-strings, which is what keeps a half-migrated row from throwing here.
 */
const sanitize = (value: unknown): string => sanitizeProvenanceText(value)

/** Sanitizes a field whose empty result must read as a sentinel, not as blank. */
const sanitizeField = (value: unknown): string =>
  sanitize(value) || PROVENANCE_UNKNOWN

/** Sentinel values are never painted green — only a real answer is. */
const known = (value: string, code: string): string =>
  color(value === PROVENANCE_UNKNOWN ? YELLOW : code, value)

const detailLine = (label: string, value: string): string =>
  `    ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`

function formatWorkingTree(
  dirtyPaths: string[],
  truncated: boolean,
  captureIncomplete: boolean
): string {
  if (dirtyPaths.length > 0) {
    const shown = dirtyPaths.slice(0, DIRTY_PATHS_SHOWN).join(', ')
    const more = dirtyPaths.length > DIRTY_PATHS_SHOWN || truncated ? ', …' : ''
    const count = truncated ? `${dirtyPaths.length}+` : `${dirtyPaths.length}`
    return color(RED, `⚠ ${count} dirty: ${shown}${more}`)
  }

  // An empty list is what a failed probe and a clean tree both produce, so a
  // capture that did not complete must not be presented as a clean bill of
  // health. Blamed on the capture as a whole, not on the dirty-tree probe:
  // any recorded error means at least one answer here is unverified.
  if (captureIncomplete)
    return color(YELLOW, `${PROVENANCE_UNKNOWN} (capture incomplete)`)

  return color(GREEN, 'clean')
}

function formatPushState(commitOnRemote: unknown): string {
  if (commitOnRemote === true) return ''
  if (commitOnRemote === false)
    return color(RED, ' ✗ NOT PUSHED (per local refs)')
  return color(YELLOW, ' (push state unknown)')
}

function unrenderableLines(error: unknown): string[] {
  return [
    detailLine(
      'Provenance',
      color(
        YELLOW,
        `${PROVENANCE_UNKNOWN} — block could not be rendered: ${sanitizeField(
          error instanceof Error ? error.message : error
        )}`
      )
    ),
  ]
}

/**
 * Formats a proposal's provenance for the signing prompt.
 *
 * Renders an explicit "not recorded" line for proposals stored before capture
 * existed: a silent gap reads as "clean and authored by nobody", which is the
 * one impression the block must never give. Total by construction — a
 * hand-edited or half-migrated document degrades to an unknown line instead of
 * throwing, because a throw here aborts the signing session and takes every
 * remaining network in the run with it.
 * @param provenance - The stored block, or `undefined` on a legacy row.
 * @returns Detail lines to append to the signing prompt; never empty.
 */
export function formatProvenanceLines(
  provenance?: IProposalProvenance
): string[] {
  if (!provenance)
    return [
      detailLine(
        'Provenance',
        color(YELLOW, '— not recorded (proposal predates provenance capture) —')
      ),
    ]

  try {
    const handle = sanitizeField(provenance.proposerHandle)
    const actor = sanitizeField(provenance.actor)
    const commit = sanitizeField(provenance.gitCommit)
    const branch = sanitizeField(provenance.gitBranch)
    const dirtyPaths = toSanitizedList(provenance.dirtyTreeScoped)
    const captureErrors = toSanitizedList(provenance.captureErrors)
    const shortCommit =
      commit === PROVENANCE_UNKNOWN ? commit : commit.slice(0, 12)

    const lines = [
      detailLine('Proposed by', `${known(handle, GREEN)} (${actor})`),
      detailLine(
        'Source',
        `${known(shortCommit, CYAN)} @ ${known(branch, CYAN)}${formatPushState(
          provenance.commitOnRemote
        )}`
      ),
      detailLine(
        'Working tree',
        formatWorkingTree(
          dirtyPaths,
          provenance.dirtyTreeTruncated === true,
          captureErrors.length > 0
        )
      ),
    ]

    const prUrl = sanitize(provenance.prUrl)
    if (prUrl) lines.push(detailLine('PR', color(CYAN, prUrl)))

    // A rationale of nothing but control characters sanitizes to empty, which
    // must read as "none given" rather than as a blank but present reason.
    const reason = sanitize(provenance.reason)
    lines.push(
      detailLine(
        'Reason',
        reason ? color(GREEN, reason) : color(YELLOW, '— none given —')
      )
    )

    // Surfaced so a row full of sentinels is explainable rather than mysterious.
    if (captureErrors.length > 0)
      lines.push(
        detailLine(
          'Capture',
          color(
            YELLOW,
            `⚠ incomplete (${captureErrors.length}): ${captureErrors[0]}`
          )
        )
      )

    return lines
  } catch (error) {
    return unrenderableLines(error)
  }
}

/** Coerces a field typed as an array but not guaranteed to be one on disk. */
function toSanitizedList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => sanitize(entry)).filter(Boolean)
}
