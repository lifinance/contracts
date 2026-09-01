import { sanitizeProvenanceText } from '../shared/git-provenance'

/** Longest rationale kept; the field is a one-liner for a signer, not a log. */
export const MAX_PROPOSAL_REASON_LENGTH = 200

/**
 * Normalizes a free-text proposal rationale into a single tidy line.
 * @param raw - Rationale as supplied by a caller or the environment.
 * @returns The collapsed, length-capped line, or `undefined` when empty.
 */
export function normalizeProposalReason(
  raw: string | undefined
): string | undefined {
  const collapsed = sanitizeProvenanceText(raw)
  if (collapsed.length === 0) return undefined
  // Capped by code point, so the cut cannot leave a lone surrogate half behind.
  return [...collapsed].slice(0, MAX_PROPOSAL_REASON_LENGTH).join('')
}

/**
 * Linear's own issue-identifier shape: a team key then a number. Matches the
 * pattern `.github/scripts/ticket-linkage-metric.sh` already measures PR→ticket
 * linkage with, so "linked" means the same thing in both places.
 */
const TICKET_ID = /^[A-Z][A-Z0-9]*-\d+$/

/** Workspace a bare ticket id is expanded against. */
const LINEAR_WORKSPACE = 'lifi-linear'

const LINEAR_HOST = 'linear.app'

export interface ITicketLinkAccepted {
  ok: true
  url: string
}

export interface ITicketLinkRejected {
  ok: false
  /** `absent` means nothing was supplied; `invalid` means it was not a link. */
  kind: 'absent' | 'invalid'
  message: string
}

export type TicketLinkResult = ITicketLinkAccepted | ITicketLinkRejected

export const MISSING_TICKET_MESSAGE =
  'No Linear ticket supplied. Every Safe proposal must carry one: pass --ticket <url|TEAM-123>, or export SAFE_PROPOSAL_TICKET before running the deploy script.'

/**
 * Accepts a Linear issue link, or a bare issue id expanded into one.
 *
 * The shape is validated rather than merely checked for non-emptiness: a hard
 * block that accepts any string records "a link" that leads nowhere, which is
 * worse than no field at all because it reads as intent that was captured.
 *
 * @param raw - What the operator passed, from a flag or the environment.
 * @returns The canonical URL, or why it was refused.
 */
export const parseTicketLink = (raw: string | undefined): TicketLinkResult => {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0)
    return { ok: false, kind: 'absent', message: MISSING_TICKET_MESSAGE }

  const invalid = (detail: string): ITicketLinkRejected => ({
    ok: false,
    kind: 'invalid',
    message: `'${trimmed}' is not a Linear issue link: ${detail}`,
  })

  if (TICKET_ID.test(trimmed))
    return {
      ok: true,
      url: `https://${LINEAR_HOST}/${LINEAR_WORKSPACE}/issue/${trimmed}`,
    }

  if (!trimmed.includes('://'))
    return invalid('expected an issue URL or a bare id like EXSC-123')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return invalid('not a parseable URL')
  }

  // Compared as a whole host, never as a substring: `linear.app.evil.com`
  // contains the real host and an endsWith check would accept it.
  if (parsed.hostname !== LINEAR_HOST)
    return invalid(`host is '${parsed.hostname}', expected '${LINEAR_HOST}'`)

  const segments = parsed.pathname.split('/').filter(Boolean)
  const issueAt = segments.indexOf('issue')
  if (issueAt === -1)
    return invalid("path has no '/issue/' segment, so it is not an issue link")

  const id = segments[issueAt + 1]
  if (!id || !TICKET_ID.test(id))
    return invalid(
      `'${id ?? ''}' after /issue/ is not an issue id like EXSC-123`
    )

  return { ok: true, url: trimmed }
}

export interface IProposalIntentInput {
  /** `--ticket`, when the caller has a CLI. */
  ticket?: string
  /** `SAFE_PROPOSAL_TICKET`; the channel the bash deploy chain uses. */
  envTicket?: string
  /** `--reason`. */
  reason?: string
  /** `SAFE_PROPOSAL_REASON`. */
  envReason?: string
}

export interface IProposalIntent {
  ticketUrl: string
  reason?: string
  /**
   * True when no reason was supplied. The proposal still goes ahead (OQ3), but
   * this is the event the flip trigger counts.
   */
  reasonMissing: boolean
}

/**
 * Resolves the human intent that travels with a proposal.
 *
 * The ticket blocks and the reason does not, which is the asymmetry OQ3 and
 * Daniel's 2026-08-31 ruling ask for: the ticket is the durable anchor other
 * checks lean on, while the reason is a courtesy to the signer that is being
 * rolled out on a measured trigger rather than mandated up front.
 *
 * @param input - Flag values and their environment fallbacks.
 * @returns The ticket URL, the reason if there is one, and whether to warn.
 * @throws If no ticket was supplied, or the one supplied is not a Linear issue link.
 */
export const resolveProposalIntent = (
  input: IProposalIntentInput
): IProposalIntent => {
  const ticket = parseTicketLink(input.ticket ?? input.envTicket)
  if (!ticket.ok) throw new Error(ticket.message)

  const reason = normalizeProposalReason(input.reason ?? input.envReason)

  return {
    ticketUrl: ticket.url,
    ...(reason ? { reason } : {}),
    reasonMissing: reason === undefined,
  }
}

/**
 * @param ticketUrl - Shown so the warning identifies which proposal it is about.
 * @returns The one-line warning for a proposal with no stated reason.
 */
export const formatReasonWarning = (ticketUrl: string): string =>
  `No --reason given for ${ticketUrl}. The signer sees the ticket but not why this is being proposed now — pass --reason "<one line>" or export SAFE_PROPOSAL_REASON.`

/**
 * OQ3's flip trigger: the reason becomes mandatory once the warning has fired
 * zero times across this many consecutive proposals.
 */
export const REASON_FLIP_WINDOW = 30

export interface IReasonAdoption {
  /** How many proposals the window actually contained. */
  examined: number
  /** How many of them carried no usable reason. */
  reasonless: number
  /** Unbroken run of reasoned proposals, counted back from the newest. */
  consecutiveWithReason: number
  /** Whether OQ3's condition is met right now. */
  flipReady: boolean
}

/**
 * Reads the reason-adoption counter OQ3's flip trigger is defined against.
 *
 * Derived from the proposals themselves rather than from a stored integer: a
 * separate counter is a second source of truth that can disagree with the
 * proposals, and a per-process one cannot span 30 of them. The absent
 * `provenance.reason` field IS the recorded warning, so this cannot drift.
 *
 * @param proposals - Provenance blocks, NEWEST FIRST, as the query returns them.
 * @returns The counter read, and whether the trigger is met.
 */
export const summarizeReasonAdoption = (
  proposals: { reason?: string }[]
): IReasonAdoption => {
  // Normalized, not merely truthy: `--reason "  "` stores a blank the signer
  // learns nothing from, and must not count toward the flip.
  const hasReason = proposals.map(
    (p) => normalizeProposalReason(p.reason) !== undefined
  )

  const firstReasonless = hasReason.indexOf(false)
  const consecutiveWithReason =
    firstReasonless === -1 ? hasReason.length : firstReasonless

  return {
    examined: proposals.length,
    reasonless: hasReason.filter((present) => !present).length,
    consecutiveWithReason,
    flipReady: consecutiveWithReason >= REASON_FLIP_WINDOW,
  }
}
