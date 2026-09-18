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

import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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
  // Blank, exactly as `.env.example` ships them and as every checkout derived
  // from it carries them. Omitting them made the sandbox the one shape where a
  // caller's exported ticket survives `set -a; source .env`.
  'SAFE_PROPOSAL_TICKET=',
  'SAFE_PROPOSAL_REASON=',
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

const run = (
  args: string[],
  options: { env?: Record<string, string> } = {}
): { output: string; refused: boolean } => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // `bun test` sets NODE_ENV=test; this child is exercised as a CLI.
  delete env.NODE_ENV
  // Set empty rather than deleted, so a developer's own exported ticket cannot
  // decide the cases below. A case that is about a supplied ticket overrides
  // this through `options.env`.
  env.SAFE_PROPOSAL_TICKET = ''
  env.SAFE_PROPOSAL_REASON = ''
  // The mirrors too: they are the channel that survives the env file, so a
  // developer's inherited one would otherwise rescue the refusal cases.
  env.RESOLVED_SAFE_PROPOSAL_TICKET = ''
  env.RESOLVED_SAFE_PROPOSAL_REASON = ''
  Object.assign(env, options.env ?? {})
  withholdCredentials(env)
  const shim = toolchainShim()
  env.PATH = `${shim}:${env.PATH ?? ''}`

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
  rmSync(shim, { recursive: true, force: true })

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

describe("the caller's ticket outranks the env file", () => {
  it('accepts an exported ticket on a checkout whose .env blanks it', () => {
    // The regression this pins: `set -a; source .env` runs on every entry into
    // the framework, and a checkout derived from `.env.example` carries a blank
    // SAFE_PROPOSAL_TICKET line, so a plain export was overwritten before the
    // guard ever read it. An agent following [CONV:DEPLOY-TICKET] exactly was
    // refused and told to export what it had already exported.
    const result = run(
      ['CalldataVerificationFacet', 'gnosis', '--production'],
      {
        env: { SAFE_PROPOSAL_TICKET: 'EXSC-1034' },
      }
    )

    expect(result.refused).toBe(false)
    expect(result.output).toContain(PAST_THE_GUARD)
    // Naming the ticket, not just the absence of a refusal: a run that adopted
    // some other ticket — an inherited mirror, say — also gets past the guard
    // and prints the marker, and would satisfy the two assertions above.
    expect(result.output).toContain('issue/EXSC-1034')
  })

  it('carries an exported reason through the same clobber', () => {
    const result = run(
      ['CalldataVerificationFacet', 'gnosis', '--production'],
      {
        env: {
          SAFE_PROPOSAL_TICKET: 'EXSC-1034',
          SAFE_PROPOSAL_REASON: 'roll out FeeForwarder v2.0.0',
        },
      }
    )

    expect(result.refused).toBe(false)
    expect(result.output).toContain('roll out FeeForwarder v2.0.0')
  })
})

describe('the single-contract entry point resolves a ticket before it builds', () => {
  // Asserted on the source rather than by spawning it. `deploySingleContract`
  // is a function that re-sources the framework inside its own body, so a
  // stubbed helper is discarded and any run that got past the guard would
  // broadcast for real; and its ticket guard sits behind the tree-recordable
  // and toolchain guards, which a sandbox of symlinks cannot satisfy — a spawn
  // dies at one of those and its silence would say nothing about this guard.
  // What is unproven for this entry point is only the guard's position, which
  // is exactly what the ordering below pins.
  const source = readFileSync(
    join(REPO_ROOT, 'script', 'deploy', 'deploySingleContract.sh'),
    'utf8'
  ).split('\n')
  const lineOf = (pattern: RegExp): number => {
    const index = source.findIndex((line) => pattern.test(line))
    if (index === -1)
      throw new Error(`nothing in deploySingleContract.sh matches ${pattern}`)
    return index
  }

  it('calls the guard before the first build and the first broadcast', () => {
    const guard = lineOf(/^\s*if ! assertProposalTicketForRun /)

    expect(guard).toBeLessThan(lineOf(/forge build /))
    expect(guard).toBeLessThan(lineOf(/^\s*executeAndParse /))
  })
})

describe('every entry point captures before the env file', () => {
  // The miss this pins: the capture has to sit above an entry point's own
  // `source .env`, and each of these starts its own process, so none of them
  // inherits one from a parent. `syncWhitelistToNetworks.sh` shipped the bug
  // this way — a live Safe-proposal path whose ordering nothing checked.
  //
  // Listed rather than discovered: the entry points differ in shape (a
  // `BASH_SOURCE` guard, top-level statements, a `main` call at the bottom), and
  // every heuristic that covers one shape silently drops another. The sweep
  // below is the backstop that catches a new file this list forgets.
  const ENTRY_POINTS = [
    'script/helperFunctions.sh',
    'script/scriptMaster.sh',
    'script/deploy/deployContractToNetworks.sh',
    'script/tasks/proposeContractToNetworks.sh',
    'script/tasks/syncWhitelistToNetworks.sh',
  ]

  const orderIn = (file: string): { capture: number; env: number } => {
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    return {
      capture: lines.findIndex((line) =>
        line.includes('captureProposalIntent.sh')
      ),
      env: lines.findIndex((line) => /^\s*source \.env\s*$/.test(line)),
    }
  }

  it.each(ENTRY_POINTS)('%s captures first', (file) => {
    const { capture, env } = orderIn(file)

    expect(env).toBeGreaterThan(-1)
    expect(capture).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(env)
  })

  it('has no direct-exec script that sources the env file uncaptured', () => {
    const guarded = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-E',
        'BASH_SOURCE\\[0\\]}" == "\\$\\{0}"',
        '--',
        'script',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean)

    // Zero matches would let this pass by checking nothing.
    expect(guarded.length).toBeGreaterThan(0)

    for (const file of guarded) {
      const { capture, env } = orderIn(file)
      if (env === -1) continue
      expect(capture).toBeGreaterThan(-1)
      expect(capture).toBeLessThan(env)
    }
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
