/**
 * Proposal provenance display
 *
 * Renders the provenance block of a Safe proposal as the claim a signer weighs
 * the calldata against: the reason the proposer gave, who produced it, and the
 * two links where that reason was reviewed.
 *
 * The reason leads, because it is the only assertion on the screen no gate can
 * grade — every other line here exists to say who made it and where to check
 * it.
 */

import {
  PROVENANCE_UNKNOWN,
  sanitizeProvenanceText,
} from '../shared/git-provenance'

import { MAX_PROPOSAL_REASON_LENGTH } from './proposal-intent'
import { type IProposalProvenance } from './safe-utils'

/** Dirty paths named inline before the list is elided. */
const DIRTY_PATHS_SHOWN = 3
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
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

/** Indent of every line inside the claim block. */
const CLAIM_INDENT = '      '
/** The signer view's width; the block is folded to it. */
const CLAIM_WIDTH = 140

/**
 * Folds one claim line to the view's width.
 *
 * A token longer than the remaining budget is never broken: the long tokens
 * here are the PR and ticket URLs, and a URL split across two lines cannot be
 * clicked, copied, or compared against the host it claims to be on.
 */
const foldClaim = (text: string, indent: string): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ').filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (`${indent}${next}`.length > CLAIM_WIDTH && line) {
      out.push(`${indent}${line}`)
      line = word
    } else line = next
  }
  if (line) out.push(`${indent}${line}`)
  return out
}

/**
 * How sure the block is of what it is stating, which is all colour says here.
 *
 * Zone 1 states and zone 2 grades, so nothing in this block is painted for
 * being *bad*. What is painted is whether the line is a measurement (`ok`), a
 * sentinel standing in for one (`unknown`), or a measurement that came back
 * carrying something the signer has to see — a dirty tree, an unpushed commit.
 */
type Certainty = 'measured' | 'unknown' | 'carries'

const CERTAINTY_COLOUR: Record<Certainty, string> = {
  measured: '',
  unknown: YELLOW,
  carries: RED,
}

/**
 * A supporting line under the reason.
 *
 * Folded as plain text and coloured afterwards: folding coloured text would
 * measure the escape sequences as width, and a fold landing inside one would
 * leave the rest of the block painted.
 */
const claimLine = (
  value: string,
  certainty: Certainty = 'measured'
): string[] => {
  const code = CERTAINTY_COLOUR[certainty]
  return foldClaim(`— ${value}`, CLAIM_INDENT).map((line) =>
    code ? color(code, line) : line
  )
}

type WorkingTreeUnverified = 'capture-incomplete' | 'unreadable' | undefined

/** A fragment of the claim line, with how sure the block is of it. */
interface IStated {
  readonly text: string
  readonly certainty: Certainty
}

function formatWorkingTree(
  dirtyPaths: string[],
  truncated: boolean,
  unverified: WorkingTreeUnverified
): IStated {
  if (dirtyPaths.length > 0) {
    const shown = dirtyPaths.slice(0, DIRTY_PATHS_SHOWN).join(', ')
    const more = dirtyPaths.length > DIRTY_PATHS_SHOWN || truncated ? ', …' : ''
    const count = truncated ? `${dirtyPaths.length}+` : `${dirtyPaths.length}`
    return { text: `${count} dirty: ${shown}${more}`, certainty: 'carries' }
  }

  // An empty list is what a failed probe, a missing/malformed field, and a
  // clean tree all produce. Only a measured empty array with no capture
  // errors may be stated as clean — anything else is the "clean and authored
  // by nobody" impression this block must never give.
  if (unverified === 'unreadable')
    return {
      text: `tree ${PROVENANCE_UNKNOWN} (unreadable)`,
      certainty: 'unknown',
    }
  if (unverified === 'capture-incomplete')
    return {
      text: `tree ${PROVENANCE_UNKNOWN} (capture incomplete)`,
      certainty: 'unknown',
    }

  return { text: 'tree clean', certainty: 'measured' }
}

function formatPushState(commitOnRemote: unknown): IStated {
  if (commitOnRemote === true) return { text: '', certainty: 'measured' }
  if (commitOnRemote === false)
    return { text: ' ✗ NOT PUSHED (per local refs)', certainty: 'carries' }
  return { text: ' (push state unknown)', certainty: 'unknown' }
}

/** The least certain of what the line is made of decides how it is painted. */
const weakest = (...parts: Certainty[]): Certainty =>
  parts.includes('carries')
    ? 'carries'
    : parts.includes('unknown')
    ? 'unknown'
    : 'measured'

function unrenderableLines(error: unknown): string[] {
  return claimLine(
    `${PROVENANCE_UNKNOWN} — block could not be rendered: ${sanitizeField(
      error instanceof Error ? error.message : error
    )}`,
    'unknown'
  )
}

/**
 * Formats a proposal's claim: the reason given, who gave it, and where it was
 * reviewed.
 *
 * Renders an explicit "not recorded" line for proposals stored before capture
 * existed: a silent gap reads as "clean and authored by nobody", which is the
 * one impression the block must never give. Total by construction — a
 * hand-edited or half-migrated document degrades to an unknown line instead of
 * throwing, because a throw here aborts the signing session and takes every
 * remaining network in the run with it.
 * @param provenance - The stored block, or `undefined` on a legacy row.
 * @returns The body of the claim block, indented; never empty.
 */
export function formatClaimLines(provenance?: IProposalProvenance): string[] {
  if (!provenance)
    return claimLine(
      'not recorded (proposal predates provenance capture)',
      'unknown'
    )

  try {
    const handle = sanitizeField(provenance.proposerHandle)
    const actor = sanitizeField(provenance.actor)
    const commit = sanitizeField(provenance.gitCommit)
    const branch = sanitizeField(provenance.gitBranch)
    const dirtyTreeIsList = Array.isArray(provenance.dirtyTreeScoped)
    const dirtyPaths = dirtyTreeIsList
      ? toSanitizedList(provenance.dirtyTreeScoped)
      : []
    const captureErrors = toSanitizedList(provenance.captureErrors)
    const workingTreeUnverified: WorkingTreeUnverified = !dirtyTreeIsList
      ? 'unreadable'
      : captureErrors.length > 0
      ? 'capture-incomplete'
      : undefined
    const shortCommit =
      commit === PROVENANCE_UNKNOWN ? commit : commit.slice(0, 12)

    // A rationale of nothing but control characters sanitizes to empty, which
    // must read as "none given" rather than as a blank but present reason.
    const reason = [...sanitize(provenance.reason)]
      .slice(0, MAX_PROPOSAL_REASON_LENGTH)
      .join('')

    const tree = formatWorkingTree(
      dirtyPaths,
      provenance.dirtyTreeTruncated === true,
      workingTreeUnverified
    )
    const push = formatPushState(provenance.commitOnRemote)
    const anyUnknown = [handle, actor, commit, branch].includes(
      PROVENANCE_UNKNOWN
    )

    const lines = [
      // The reason leads and is the only line not prefixed: it is the claim,
      // and everything under it is attribution for the claim.
      ...(reason
        ? foldClaim(`"${reason}"`, CLAIM_INDENT).map((line) =>
            color(GREEN, line)
          )
        : foldClaim('— none given —', CLAIM_INDENT).map((line) =>
            color(YELLOW, line)
          )),
      ...claimLine(
        `${handle} (${actor}) · ${shortCommit} @ ${branch}${push.text} · ${tree.text}`,
        weakest(
          tree.certainty,
          push.certainty,
          anyUnknown ? 'unknown' : 'measured'
        )
      ),
    ]

    // Both links are shown in full rather than as a shortened label. A label
    // is only clickable through an OSC-8 escape, which is a link whose target
    // the reader cannot see — on this screen the host has to stay readable.
    const prUrl = sanitize(provenance.prUrl)
    if (prUrl) lines.push(...claimLine(prUrl, 'measured'))

    // Always shown, present or not: an absent link means a row predating the
    // requirement or a hand-edited document — both things a signer should see
    // rather than have quietly omitted.
    const ticketUrl = sanitize(provenance.ticketUrl)
    lines.push(
      ...(ticketUrl
        ? claimLine(ticketUrl, 'measured')
        : claimLine('no ticket recorded', 'unknown'))
    )

    // Surfaced so a row full of sentinels is explainable rather than mysterious.
    if (captureErrors.length > 0)
      lines.push(
        ...claimLine(
          `capture incomplete (${captureErrors.length}): ${captureErrors[0]}`,
          'unknown'
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
