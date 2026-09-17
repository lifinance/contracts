/**
 * Where the deploy pre-flight sits, not what it decides —
 * `deploy-ticket-preflight.test.ts` covers the decision.
 *
 * The claim under test is positional: the ticket is resolved before anything is
 * compiled or broadcast. So each case pairs its refusal with the absence of the
 * marker the driver prints immediately after the guard, because the funnel
 * backstop emits the same refusal text from the far side of a deployment — a
 * deleted guard would still "refuse", just after spending one.
 *
 * Containment, because a broken guard would otherwise let this suite deploy:
 * the children re-`source` the repo env file, so withholding credentials
 * through the environment does not hold for a bash child the way it does for
 * the TypeScript ones. A PATH shim makes `forge` and `cast` unusable instead,
 * so the worst a regression can do here is fail on the shim.
 *
 * Spawns the real entry points, following `ticket-gate-placement.test.ts`.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { branchTicketCandidate } from './deploy-ticket-preflight'
import { withholdCredentials } from './spawn-env'

const REFUSAL = 'No Linear ticket supplied'
/** Printed by the driver on the statement after the guard, and by nothing else. */
const PAST_THE_GUARD = '[info] deploying'
const SHIM_MARKER = 'toolchain-shim-refused'

/** 90 seconds: the bash chain sources its framework before reaching the guard. */
const TIMEOUT_MS = 90_000

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * A directory whose `forge` and `cast` refuse to run, to be put in front of PATH.
 *
 * @returns the directory to prepend
 */
const toolchainShim = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-preflight-shim-'))
  for (const tool of ['forge', 'cast']) {
    const path = join(dir, tool)
    writeFileSync(
      path,
      `#!/bin/sh\necho "${SHIM_MARKER} ${tool}" >&2\nexit 1\n`
    )
    chmodSync(path, 0o755)
  }
  return dir
}

const run = (args: string[]): { output: string; refused: boolean } => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // `bun test` sets NODE_ENV=test; this child is exercised as a CLI.
  delete env.NODE_ENV
  // Set empty rather than deleted, so a developer's own exported ticket cannot
  // decide the cases below. The repo env file defines no ticket, so sourcing it
  // in the child leaves this standing.
  env.SAFE_PROPOSAL_TICKET = ''
  withholdCredentials(env)
  env.PATH = `${toolchainShim()}:${env.PATH ?? ''}`

  const result = Bun.spawnSync(
    ['bash', join('script', 'deploy', 'deployContractToNetworks.sh'), ...args],
    {
      cwd: REPO_ROOT,
      env,
      timeout: TIMEOUT_MS,
      // Closed, so a regression that reaches an interactive prompt fails the
      // case instead of hanging the suite — and so this exercises the
      // no-terminal path an agent-driven rollout takes.
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  // A killed child is not a result: without this, "the marker did not appear"
  // passes on a run that was stopped before it could appear.
  if (result.signalCode !== null && result.signalCode !== undefined)
    throw new Error(
      `child was killed by ${result.signalCode} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )

  return { output, refused: output.includes(REFUSAL) }
}

describe('the deploy driver resolves a ticket before it builds', () => {
  it('refuses a production rollout with no ticket, before the first build', () => {
    const result = run(['CalldataVerificationFacet', 'gnosis', '--production'])

    expect(result.refused).toBe(true)
    expect(result.output).not.toContain(PAST_THE_GUARD)
    // The containment shim is never reached on a working guard. Asserting it
    // stayed quiet is what separates "refused at the guard" from "refused
    // because the toolchain was unusable".
    expect(result.output).not.toContain(SHIM_MARKER)
  })

  it('names the branch candidate in the refusal when the branch has one', () => {
    // The suggestion is what makes the refusal one command to fix. It is only
    // asserted when the checkout's branch actually names an issue, so this case
    // cannot fail on a branch it says nothing about.
    const branch = Bun.spawnSync(['git', 'branch', '--show-current'], {
      cwd: REPO_ROOT,
    })
      .stdout.toString()
      .trim()
    if (branchTicketCandidate(branch) === undefined) return

    expect(
      run(['CalldataVerificationFacet', 'gnosis', '--production']).output
    ).toContain('export SAFE_PROPOSAL_TICKET=')
  })
})

describe('the deploy driver does not ask on runs that propose nothing', () => {
  it('lets a testnet rollout past the guard with no ticket', () => {
    // The case that exercises the condition rather than the guard: a testnet
    // diamond is EOA-owned and sends directly, so a guard called
    // unconditionally would refuse a run that creates no proposal. It gets past
    // the guard and then dies on the shim, which is the marker that it got
    // there — and the reason this case can assert an absence of refusal without
    // that absence coming from an early exit.
    const result = run(['CalldataVerificationFacet', 'sepolia', '--production'])

    expect(result.refused).toBe(false)
    expect(result.output).toContain(PAST_THE_GUARD)
  })
})
