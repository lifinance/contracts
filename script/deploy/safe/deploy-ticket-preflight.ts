/**
 * Resolves the Linear ticket a deploy run's proposals will carry, before the
 * run spends anything.
 *
 * `storeTransactionInMongoDB` is where the requirement is unbypassable and it
 * stays there, but it runs after the contract is on chain: a rollout started
 * with no ticket exported compiles, broadcasts, writes a deployment record and
 * attempts explorer verification, and only then refuses. Resolving the same
 * value at the start of the run makes a missing environment variable cost one
 * message instead of a deployment.
 *
 * The id in the branch name is offered as a default for a human to accept, and
 * never attached on its own. A deploy branch usually names the code ticket
 * rather than the rollout being deployed, and the ticket is the anchor the
 * signer leans on — a plausible-but-wrong one is worse than a refusal, because
 * it reads as intent that was captured.
 */
import { MISSING_TICKET_MESSAGE, parseTicketLink } from './proposal-intent'

/**
 * A Linear issue id inside a branch name.
 *
 * The team key is letters only and at most six of them, which is what separates
 * an id from the rest of a branch: a looser class reads
 * `signing2-deploytest-0917` as `DEPLOYTEST-0917`, which `parseTicketLink`
 * accepts and expands into a URL for an issue that does not exist. A
 * well-formed wrong answer is the one outcome this must not produce.
 */
const BRANCH_TICKET = /(?:^|[/_-])([A-Za-z]{2,6}-\d{1,6})(?=[-_/]|$)/

/**
 * @param branch - a git branch name, or undefined on a detached HEAD
 * @returns the issue id the branch names, uppercased, or undefined
 */
export const branchTicketCandidate = (
  branch: string | undefined
): string | undefined => BRANCH_TICKET.exec(branch ?? '')?.[1]?.toUpperCase()

/**
 * @param candidate - the branch's issue id, when it names one
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
  /** The current branch, used for the suggestion only. */
  branch?: string
  /**
   * Whether a human is there to answer. False for CI, for an agent-driven
   * rollout and for any piped run — all of which must be refused rather than
   * left waiting on a prompt nobody will see.
   */
  interactive: boolean
  /**
   * Asks the operator; required when `interactive`. Asynchronous because the
   * only real implementation is a readline prompt, and duplicating the question
   * text into the caller to keep this synchronous is how the two drift apart.
   */
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
    const typed = await input.ask(
      `Linear ticket for this run's proposals${
        candidate ? ` [${candidate}]` : ''
      }: `
    )
    answer = typed.trim() || (candidate ?? '')
  }

  const parsed = parseTicketLink(answer)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.url
}
