/**
 * Proposal intent: the Linear ticket link and the one-line reason that travel
 * with every Safe proposal.
 *
 * Import this from any proposal funnel, or from an entry point that wants to
 * refuse a run before it signs. It carries no Safe, Mongo or network
 * dependency, which is what lets an entry point check the intent before opening
 * either — and what lets `safe-utils.ts` import it without a cycle.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

/** Longest rationale kept; the field is a one-liner for a signer, not a log. */
export const MAX_PROPOSAL_REASON_LENGTH = 200

/**
 * Longest ticket link stored. Linear truncates its own URL slugs, so a real
 * issue URL runs to roughly 120 characters; the cap bounds a value written to
 * every proposal document and rendered to signers.
 */
export const MAX_TICKET_URL_LENGTH = 300

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
 * Linear's own issue-identifier shape: a team key then a number. Deliberately
 * stricter than the pattern `.github/scripts/ticket-linkage-metric.sh` greps PR
 * text with — that one only counts linkage and can afford false positives.
 */
const TICKET_ID = /^[A-Z][A-Z0-9]*-\d+$/

/** Workspace a bare ticket id is expanded against. */
const LINEAR_WORKSPACE = 'lifi-linear'

const LINEAR_HOST = 'linear.app'

/** A ticket link that passed validation, reduced to its canonical URL. */
export interface ITicketLinkAccepted {
  ok: true
  url: string
}

/** A refused ticket link, with the reason an operator is shown. */
export interface ITicketLinkRejected {
  ok: false
  /** `absent` means nothing was supplied; `invalid` means it was not a link. */
  kind: 'absent' | 'invalid'
  message: string
}

/** Outcome of validating a ticket link. */
export type TicketLinkResult = ITicketLinkAccepted | ITicketLinkRejected

/**
 * Refusal shown when no ticket was supplied. Leads with the environment
 * variable because every proposal path reads it, while only some offer a
 * `--ticket` flag.
 */
export const MISSING_TICKET_MESSAGE =
  'No Linear ticket supplied. Every Safe proposal must carry one: export SAFE_PROPOSAL_TICKET=<url|TEAM-123>, or pass --ticket where the script offers it.'

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
  if (trimmed.length > MAX_TICKET_URL_LENGTH)
    return {
      ok: false,
      kind: 'invalid',
      message: `ticket link is ${trimmed.length} characters, longer than the ${MAX_TICKET_URL_LENGTH} allowed`,
    }
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

  // The host check further down is not enough on its own:
  // `javascript://linear.app/issue/EXSC-1` also parses with hostname
  // `linear.app`, so a scheme that executes wherever this link is rendered would
  // reach the signer's provenance block. Linear serves nothing over http either.
  if (parsed.protocol !== 'https:')
    return invalid(`scheme is '${parsed.protocol}', expected https`)

  // `hostname` excludes userinfo, so the host check below passes
  // `https://user:secret@linear.app/issue/EXSC-1`, which would then be stored
  // and rendered to signers verbatim, credentials and all. This is the one
  // rejection that does not echo the input, since that would print the very
  // credential it is refusing.
  if (parsed.username !== '' || parsed.password !== '')
    return {
      ok: false,
      kind: 'invalid',
      message:
        'The ticket link carries credentials before the host. Pass the plain issue URL, or a bare id like EXSC-123.',
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

  // The parsed form, not the raw input: URL parsing drops the tab and newline
  // characters it tolerates mid-string, so storing `trimmed` would put a
  // multi-line value in a field other renderers are free to trust.
  return { ok: true, url: parsed.href }
}

/** Raw intent as a caller supplies it: each flag with its environment fallback. */
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

/** Resolved intent that travels with a proposal onto its provenance block. */
export interface IProposalIntent {
  ticketUrl: string
  reason?: string
  /**
   * True when no reason was supplied. The proposal still goes ahead, but this is
   * the event the flip trigger counts.
   */
  reasonMissing: boolean
}

/**
 * Resolves the human intent that travels with a proposal.
 *
 * The ticket blocks and the reason does not: the ticket is the durable anchor
 * other checks lean on, while the reason is being rolled out on a measured
 * trigger rather than mandated up front.
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
  `No reason given for ${ticketUrl}. The signer sees the ticket but not why this is being proposed now — export SAFE_PROPOSAL_REASON="<one line>", or pass --reason where the script offers it.`

/**
 * The reason becomes mandatory once the warning has fired zero times across
 * this many consecutive proposals.
 */
export const REASON_FLIP_WINDOW = 30

/** The reason-adoption counter the OQ3 flip trigger is defined against. */
export interface IReasonAdoption {
  /** How many proposals the window actually contained. */
  examined: number
  /** How many of them carried no usable reason. */
  reasonless: number
  /** Unbroken run of reasoned proposals, counted back from the newest. */
  consecutiveWithReason: number
  /** Whether the flip trigger's condition is met right now. */
  flipReady: boolean
}

/**
 * Reads the reason-adoption counter the flip trigger is defined against.
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

/**
 * Refuses a run with no valid ticket, before it does anything.
 *
 * `storeTransactionInMongoDB` is the unbypassable check, but it runs after the
 * transaction has been signed — a Ledger tap already spent, and on a fleet
 * script once per network. Calling this at a script's entry turns that into one
 * message before any signing starts.
 *
 * @param ticket - An explicit flag value, when the script has one.
 * @returns The canonical ticket URL.
 * @throws If no ticket is available, or it is not a Linear issue link.
 */
export const assertTicketPresent = (ticket?: string): string => {
  const result = parseTicketLink(ticket ?? process.env.SAFE_PROPOSAL_TICKET)
  if (!result.ok) throw new Error(result.message)
  return result.url
}
