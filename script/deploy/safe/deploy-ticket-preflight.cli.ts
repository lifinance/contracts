/**
 * Prints the Linear issue URL a deploy run's proposals will carry, or refuses.
 *
 * The bash deploy chain captures stdout, so the URL is the only thing written
 * there: the prompt and every refusal go to stderr, where the operator still
 * reads them and the caller's `$(...)` does not.
 */
import { execFileSync } from 'child_process'
import { createInterface } from 'readline'

import {
  branchTicketCandidate,
  deployTicketRefusal,
  resolveDeployTicket,
} from './deploy-ticket-preflight'

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

try {
  const url = await resolveDeployTicket({
    envTicket: process.env.SAFE_PROPOSAL_TICKET,
    branch,
    interactive,
    // The callback form rather than `readline/promises`, whose subpath the
    // repo's TypeScript resolution does not see.
    // The callback form rather than `readline/promises`, whose subpath the
    // repo's TypeScript resolution does not see. `close` has to settle it too:
    // on Ctrl-D the question's callback never fires, and an unsettled promise
    // hangs the deploy chain rather than refusing it.
    ask: (question) =>
      new Promise((resolve, reject) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        })
        let answered = false
        rl.question(question, (answer) => {
          answered = true
          rl.close()
          resolve(answer)
        })
        rl.on('close', () => {
          if (!answered) reject(new Error(deployTicketRefusal(candidate)))
        })
      }),
  })
  process.stdout.write(`${url}\n`)
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
}
