#!/usr/bin/env bun
/**
 * Prints the Linear issue URL a deploy run's proposals will carry, or refuses.
 *
 * The bash deploy chain captures stdout, so the URL is the only thing written
 * there: the prompt and every refusal go to stderr, where the operator still
 * reads them and the caller's `$(...)` does not.
 */
import { execFileSync } from 'child_process'
import { createInterface } from 'readline'

import { resolveDeployTicket } from './deploy-ticket-preflight'

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

// A prompt nobody is there to answer is worse than a refusal: it hangs an
// unattended rollout instead of failing it, so the terminal test decides which
// of the two this run gets.
const interactive = process.stdin.isTTY === true

try {
  const url = await resolveDeployTicket({
    envTicket: process.env.SAFE_PROPOSAL_TICKET,
    branch: currentBranch(),
    interactive,
    // The callback form rather than `readline/promises`, whose subpath the
    // repo's TypeScript resolution does not see.
    ask: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        })
        rl.question(question, (answer) => {
          rl.close()
          resolve(answer)
        })
      }),
  })
  process.stdout.write(`${url}\n`)
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
}
