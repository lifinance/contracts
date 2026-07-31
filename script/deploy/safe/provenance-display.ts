/**
 * Proposal provenance display
 *
 * Renders the provenance block of a Safe proposal as detail lines for the
 * signing prompt. Import from `confirm-safe-tx.ts` so a signer can see which
 * code produced the proposal, and whether that code is fetchable and matches a
 * clean tree, without leaving the CLI.
 *
 * Kept out of the CLI script itself so the formatting is unit-testable, the
 * same way the Ledger Flex filmstrip is factored. The lines are plain strings
 * assembled here, not decoded transaction data, so the single-entry-point rule
 * for decoded display (rule 201) does not apply.
 */

import { PROVENANCE_UNKNOWN } from '../shared/git-provenance'

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

const detailLine = (label: string, value: string): string =>
  `    ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`

function formatWorkingTree(dirtyPaths: string[], truncated: boolean): string {
  if (dirtyPaths.length === 0) return color(GREEN, 'clean')

  const shown = dirtyPaths.slice(0, DIRTY_PATHS_SHOWN).join(', ')
  const more = dirtyPaths.length > DIRTY_PATHS_SHOWN || truncated ? ', …' : ''
  const count = truncated ? `${dirtyPaths.length}+` : `${dirtyPaths.length}`
  return color(RED, `⚠ ${count} dirty: ${shown}${more}`)
}

function formatPushState(commitOnRemote: boolean | undefined): string {
  if (commitOnRemote === true) return ''
  if (commitOnRemote === false)
    return color(RED, ' ✗ NOT PUSHED (per local refs)')
  return color(YELLOW, ' (push state unknown)')
}

/**
 * Formats a proposal's provenance for the signing prompt.
 *
 * Renders an explicit "not recorded" line for proposals stored before capture
 * existed: a silent gap reads as "clean and authored by nobody", which is the
 * one impression the block must never give.
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

  // Tolerate partially written rows: a hand-edited or half-migrated document
  // must degrade to "unknown", never abort the signing session.
  const handle = provenance.proposerHandle || PROVENANCE_UNKNOWN
  const actor = provenance.actor || PROVENANCE_UNKNOWN
  const commit = provenance.gitCommit || PROVENANCE_UNKNOWN
  const branch = provenance.gitBranch || PROVENANCE_UNKNOWN
  const dirtyPaths = provenance.dirtyTreeScoped ?? []
  const shortCommit =
    commit === PROVENANCE_UNKNOWN ? commit : commit.slice(0, 12)

  const lines = [
    detailLine('Proposed by', `${color(GREEN, handle)} (${actor})`),
    detailLine(
      'Source',
      `${color(CYAN, shortCommit)} @ ${color(CYAN, branch)}${formatPushState(
        provenance.commitOnRemote
      )}`
    ),
    detailLine(
      'Working tree',
      formatWorkingTree(dirtyPaths, provenance.dirtyTreeTruncated === true)
    ),
  ]

  if (provenance.prUrl)
    lines.push(detailLine('PR', color(CYAN, provenance.prUrl)))

  lines.push(
    detailLine(
      'Reason',
      provenance.reason
        ? color(GREEN, provenance.reason)
        : color(YELLOW, '— none given —')
    )
  )

  // Surfaced so a row full of sentinels is explainable rather than mysterious.
  const captureErrors = provenance.captureErrors ?? []
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
}
