/**
 * Resolves the Linear ticket a deploy run's proposals will carry, before the
 * run spends anything. Used by the bash deploy chain through
 * `assertProposalTicketForRun`.
 */
import {
  MISSING_TICKET_MESSAGE,
  normalizeProposalReason,
  parseTicketLink,
} from './proposal-intent'

/**
 * A Linear issue id at the start of a branch name or of a path segment, which
 * is where Linear's own `user/key-123-slug` puts it.
 *
 * Anchored there rather than anywhere in the name because the loose form reads
 * `permit-2-trusted-forwarder-lf-11862` as `PERMIT-2` while the real id sits at
 * the end, and `deploy-network-xdc-2` as `XDC-2`. Over the 1005 refs in this
 * repo the loose form produces 359 candidates across 36 distinct team keys,
 * most of which are not Linear teams; this one produces 287 across 9. It is a
 * hint, never an answer, which is why the residue is tolerable.
 */
const BRANCH_TICKET = /(?:^|\/)([A-Za-z]{2,6}-\d{1,6})(?=[-_/]|$)/

/**
 * @param branch - a git branch name, or undefined on a detached HEAD
 * @returns the issue id the branch names, uppercased, or undefined
 */
export const branchTicketCandidate = (
  branch: string | undefined
): string | undefined => BRANCH_TICKET.exec(branch ?? '')?.[1]?.toUpperCase()

/**
 * @param candidate - the issue id the branch hints at, when it names one
 * @returns the refusal shown to a run that cannot be asked
 */
export const deployTicketRefusal = (candidate?: string): string =>
  candidate === undefined
    ? MISSING_TICKET_MESSAGE
    : `${MISSING_TICKET_MESSAGE} This branch names ${candidate} — export SAFE_PROPOSAL_TICKET=${candidate} if that is the ticket this rollout belongs to.`

/** What the resolver needs, so a test supplies it without a terminal or a git checkout. */
export interface IDeployTicketInput {
  /** `SAFE_PROPOSAL_TICKET` as the run inherited it. */
  envTicket?: string
  /** The current branch, used for the hint only. */
  branch?: string
  /**
   * Whether a human is there to answer. False for CI, for an agent-driven
   * rollout and for any piped run — all of which must be refused rather than
   * left waiting on a prompt nobody will see.
   */
  interactive: boolean
  /** Asks the operator; required when `interactive`. */
  ask?: (question: string) => Promise<string>
}

/**
 * @param input - the environment value, the branch, and how to ask
 * @returns the canonical Linear issue URL for this run
 * @throws If no ticket is available, or what was supplied is not a Linear
 * issue link — the same refusals the funnel gives, so the pre-flight can never
 * be laxer than the check behind it.
 */
export const resolveDeployTicket = async (
  input: IDeployTicketInput
): Promise<string> => {
  const supplied = (input.envTicket ?? '').trim()
  const candidate = branchTicketCandidate(input.branch)

  if (supplied === '' && !input.interactive)
    throw new Error(deployTicketRefusal(candidate))

  let answer = supplied
  if (answer === '') {
    if (!input.ask)
      throw new Error(
        'resolveDeployTicket was told it may ask, but given no way to'
      )
    // The branch's id is shown, never accepted on its own: `parseTicketLink`
    // validates shape and asks Linear nothing, so a bogus key off a branch name
    // expands into a URL for an issue that does not exist, and an operator has
    // no reason to doubt a default they only pressed Enter on.
    answer = (
      await input.ask(
        `Linear ticket for this run's proposals${
          candidate ? ` (this branch suggests ${candidate})` : ''
        }: `
      )
    ).trim()
  }

  const parsed = parseTicketLink(answer)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.url
}

/** What the reason resolver needs, so a test supplies it without a terminal. */
export interface IDeployReasonInput {
  /** `SAFE_PROPOSAL_REASON` as the run inherited it. */
  envReason?: string
  /** Whether a human is there to answer, on the same terms as the ticket. */
  interactive: boolean
  /** Asks the operator; only consulted when `interactive`. */
  ask?: (question: string) => Promise<string>
}

/** The question asked when a run carries no reason yet. */
export const DEPLOY_REASON_PROMPT =
  'One line on why this is being proposed now (Enter to skip): '

/**
 * Resolves the one-line reason this run's proposals will carry.
 *
 * Asked beside the ticket but never refused: the reason is being rolled out on
 * the measured trigger `REASON_FLIP_WINDOW` counts, and refusing here would flip
 * it ahead of that trigger. Asking before the run spends anything is what makes
 * a stated reason the normal case, which is the condition the trigger reads.
 *
 * @param input - the environment value and how to ask
 * @returns The normalized line, or undefined when the run carries none
 */
export const resolveDeployReason = async (
  input: IDeployReasonInput
): Promise<string | undefined> => {
  const supplied = normalizeProposalReason(input.envReason)
  if (supplied !== undefined) return supplied
  if (!input.interactive || !input.ask) return undefined
  return normalizeProposalReason(await input.ask(DEPLOY_REASON_PROMPT))
}
