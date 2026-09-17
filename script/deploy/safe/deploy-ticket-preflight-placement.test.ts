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
 * The driver runs in a sandbox of symlinks to this checkout with an env file of
 * its own, for two reasons. A bash child re-`source`s the repo env file, so
 * withholding credentials through the environment does not hold for it the way
 * it does for the TypeScript children — in the sandbox there is no credential
 * to reach. And CI has no env file at all, where the driver exits before the
 * guard and every assertion below answers a question it never asked. A PATH
 * shim makes `forge` and `cast` unusable on top of that, so the worst a
 * regression can do is fail on the shim.
 *
 * Spawns the real entry points, following `ticket-gate-placement.test.ts`.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

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

/**
 * The paths the driver reads before it reaches the guard. Symlinked rather than
 * copied, so the sandbox exercises this checkout's real scripts and config.
 */
const SANDBOX_LINKS = [
  '.git',
  'config',
  'deployments',
  'foundry.toml',
  'lib',
  'node_modules',
  'package.json',
  'script',
  'src',
  'tsconfig.json',
]

/**
 * The env file the sandbox runs on: the path settings the driver resolves
 * contracts and config through, and the production flag it cross-checks against
 * `--production`. Values are `.env.example`'s, and none of them is a
 * credential — the point of the sandbox is that there is none to hold.
 */
const SANDBOX_ENV = [
  'PRODUCTION=true',
  // Absolute, into the real checkout: `getContractFilePath` resolves a contract
  // with `find`, which does not descend into a symlinked directory, so the
  // sandbox's own `src` link would hide every contract in the repo.
  `CONTRACT_DIRECTORY="${join(REPO_ROOT, 'src')}/"`,
  `DEPLOY_SCRIPT_DIRECTORY="${join(REPO_ROOT, 'script', 'deploy', 'facets')}/"`,
  `DEPLOY_REQUIREMENTS_PATH="${join(
    REPO_ROOT,
    'script',
    'deploy',
    'resources',
    'deployRequirements.json'
  )}"`,
  `DEPLOY_CONFIG_FILE_PATH="${join(REPO_ROOT, 'config')}/"`,
  'VERIFY_CONTRACTS=false',
  'MAX_CONCURRENT_JOBS=1',
].join('\n')

/**
 * A working directory the driver can run in without this machine's env file.
 *
 * @returns the sandbox root
 */
const sandbox = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-preflight-repo-'))
  for (const entry of SANDBOX_LINKS) {
    const source = join(REPO_ROOT, entry)
    if (existsSync(source)) symlinkSync(source, join(dir, entry))
  }
  writeFileSync(join(dir, '.env'), `${SANDBOX_ENV}\n`)
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

  const root = sandbox()
  const result = Bun.spawnSync(
    ['bash', join('script', 'deploy', 'deployContractToNetworks.sh'), ...args],
    {
      cwd: root,
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

  // Symlinked entries are removed as links, never followed into the checkout.
  rmSync(root, { recursive: true, force: true })

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
