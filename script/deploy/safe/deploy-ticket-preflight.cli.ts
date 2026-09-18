/**
 * Prints the Linear issue URL a deploy run's proposals will carry, then the
 * one-line reason, or refuses.
 *
 * The bash deploy chain captures stdout, so those two lines are the only thing
 * written there: the prompts, the reason warning and every refusal go to
 * stderr, where the operator still reads them and the caller's `$(...)` does
 * not. Line 2 is empty when no reason was given, never absent, so the caller
 * reads a fixed shape. `normalizeProposalReason` collapses all whitespace, so a
 * reason cannot itself span two lines and shift the protocol.
 */
import { execFileSync } from 'child_process'
import { createInterface } from 'readline'

import {
  branchTicketCandidate,
  deployTicketRefusal,
  resolveDeployReason,
  resolveDeployTicket,
} from './deploy-ticket-preflight'
import { formatReasonWarning } from './proposal-intent'

/** @returns the checked-out branch, or undefined on a detached HEAD or outside a repo */
const currentBranch = (): string | undefined => {
  try {
    return (
      execFileSync('git', ['branch', '--show-current'], {
        encoding: 'utf8',
      }).trim() || undefined
    )
  } catch {
    return undefined
  }
}

// Both streams, because a prompt nobody is there to answer — or that nobody can
// see — hangs an unattended rollout instead of failing it. One caller runs the
// deploy chain with `2>/dev/null`, which would swallow the question while stdin
// stayed a terminal.
const interactive =
  process.stdin.isTTY === true && process.stderr.isTTY === true

const branch = currentBranch()
const candidate = branchTicketCandidate(branch)

/**
 * @param question - what the operator is shown on stderr
 * @returns what they typed; rejects when the stream closes unanswered
 */
const ask = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    let answered = false
    rl.question(question, (answer) => {
      answered = true
      rl.close()
      resolve(answer)
    })
    rl.on('close', () => {
      if (!answered) reject(new Error(deployTicketRefusal(candidate)))
    })
  })

try {
  const url = await resolveDeployTicket({
    envTicket: process.env.SAFE_PROPOSAL_TICKET,
    branch,
    interactive,
    // The callback form rather than `readline/promises`, whose subpath the
    // repo's TypeScript resolution does not see.
    ask,
  })
  // A reason that cannot be collected degrades to the warning rather than
  // failing the run: it is warn-only until its adoption trigger fires, and a
  // closed stdin at this prompt must not discard an already-resolved ticket.
  const reason = await resolveDeployReason({
    envReason: process.env.SAFE_PROPOSAL_REASON,
    interactive,
    ask,
  }).catch(() => undefined)
  if (reason === undefined)
    process.stderr.write(`${formatReasonWarning(url)}\n`)
  process.stdout.write(`${url}\n${reason ?? ''}\n`)
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
}
