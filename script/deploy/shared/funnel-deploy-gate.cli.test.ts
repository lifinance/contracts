/**
 * Placement proof for the funnel deploy gate: it has to refuse inside
 * `propose-to-safe.ts` and `propose-to-safe-tron.ts` themselves, not merely be
 * importable and correct. `funnel-deploy-gate.test.ts` covers what it decides.
 *
 * Each case runs the real CLI in a throwaway git repo, so the gate reads a tree
 * it can actually diverge. `getDeployments` resolves its path from the module
 * rather than the cwd, so address attribution still comes from this repo's real
 * production log — which is why the facet address is read out of it here.
 *
 * Every absence-assertion is paired with a positive marker, and a child killed
 * by a timeout is treated as no result at all: without that, "the refusal did
 * not appear" passes on a run that never got far enough to print it.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { TronWeb } from 'tronweb'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'

const FACET = 'AllBridgeFacet'
const FACET_PATH = `src/Facets/${FACET}.sol`
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PROPOSE_CLI = join(REPO_ROOT, 'script/deploy/safe/propose-to-safe.ts')
const TRON_CLI = join(REPO_ROOT, 'script/deploy/tron/propose-to-safe-tron.ts')

/** Long enough to reach the gate, short enough that a run past it stays cheap. */
const TIMEOUT_MS = 60_000

/** Per-case budget: these spawn a real CLI, well past bun's 5 s default. */
const CASE_TIMEOUT_MS = 90_000

const deployments = JSON.parse(
  readFileSync(join(REPO_ROOT, 'deployments/mainnet.json'), 'utf8')
) as Record<string, string>
const FACET_ADDRESS = deployments[FACET] as Address
const DIAMOND_ADDRESS = deployments.LiFiDiamond as Address

/**
 * Encodes a one-entry `diamondCut` that adds a facet.
 * @param facetAddress - facet the cut installs
 */
const addCut = (facetAddress: Address): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [
        {
          facetAddress,
          action: 0,
          functionSelectors: ['0xaabbccdd'] as Hex[],
        },
      ],
      ZERO_ADDRESS as Address,
      '0x' as Hex,
    ],
  })

const ADD_CUT = addCut(FACET_ADDRESS)

/**
 * Builds a repo whose tree matches `origin/main`, then optionally diverges the facet.
 * @param diverge - append an unmerged edit to the facet source
 * @returns the repository root
 */
const makeRepo = (diverge: boolean): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'funnel-gate-'))
  const run = (...args: string[]) =>
    spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

  // a real bare origin, because the gate refreshes origin/main before reading it
  const remote = mkdtempSync(join(tmpdir(), 'funnel-gate-remote-'))
  spawnSync('git', ['init', '--bare', '-b', 'main', remote])
  run('init', '-b', 'main')
  run('config', 'user.email', 'gate@example.com')
  run('config', 'user.name', 'gate')
  run('remote', 'add', 'origin', remote)
  mkdirSync(join(repoRoot, 'src/Facets'), { recursive: true })
  mkdirSync(join(repoRoot, 'audit'), { recursive: true })
  // the @custom:version tag is load-bearing: the gate reads it off the source
  // before it can look the facet up in the audit log
  writeFileSync(
    join(repoRoot, FACET_PATH),
    `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${FACET} {}\n`
  )
  writeFileSync(
    join(repoRoot, 'audit/auditLog.json'),
    JSON.stringify({ audits: {}, auditedContracts: {} })
  )
  run('add', '.')
  run('commit', '-m', 'merged state', '--no-gpg-sign')
  run('push', '-q', 'origin', 'main')

  if (diverge)
    writeFileSync(
      join(repoRoot, FACET_PATH),
      `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${FACET} { uint256 public unreviewed; }\n`
    )

  return repoRoot
}

/**
 * Rejects a child whose result cannot be reasoned about, and — first — one that
 * reached a real proposal store.
 *
 * The order is the whole point and it is not obvious. `spawnSync`'s `timeout`
 * reports ETIMEDOUT in `error` **and** SIGTERM in `signal` while still returning
 * whatever the child had already printed, and the Tron funnel is documented to
 * leave its Mongo connection open and hang after a successful insert. So a probe
 * that DID write is exactly the probe that looks like a timeout, and checking
 * either `error` or `signal` first would report "this proves nothing" and throw
 * the evidence away.
 * @param result - what `spawnSync` returned
 * @param output - the child's combined stdout and stderr
 */
const assertChildIsUsable = (
  result: { error?: Error; signal: NodeJS.Signals | null },
  output: string
): void => {
  // Matched loosely because each funnel words it differently: "Proposal stored
  // in MongoDB" (Tron), "Transaction successfully stored in MongoDB" (EVM),
  // "proposed and stored in MongoDB" (sendOrPropose).
  if (/stored in mongodb/i.test(output))
    throw new Error(
      'a probe reached a real proposal store — the child environment is not isolated'
    )

  // Without these, every absence assertion would pass on a run that was killed,
  // or never started, before it could print what the assertion looks for.
  if (result.error) throw result.error
  if (result.signal)
    throw new Error(
      `child was killed by ${result.signal} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )
}

/**
 * Runs a real propose CLI in a throwaway repo.
 * @param options - which CLI, its arguments, the repo to run it in, and the
 * `ENVIRONMENT` to set (deleted from the child's environment when omitted)
 * @returns the child's combined output and exit status
 */
const spawnCli = (options: {
  cli: string
  args: string[]
  repoRoot: string
  environment?: string
}): { output: string; status: number | null } => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // `bun test` sets NODE_ENV=test; these children are exercised as CLIs
  delete env.NODE_ENV
  // Bun auto-loads the repo env file into THIS process, so the child inherits a
  // real production environment unless every name is neutralised here. Deleting
  // is not sufficient on its own: `config()` inside safe-utils re-reads the env
  // file for any name that is unset, so the proposal store is pointed at an
  // unroutable host rather than removed. An earlier version of this probe
  // inherited the real store and queued a proposal on a production Safe, which
  // takes a real nonce and blocks the queue behind it.
  // Deleted, not set to a malformed value: `cwd` is the mkdtempSync fixture repo,
  // which has no env file for bun to re-load, and four cases below assert the
  // key-absent message that a malformed value would replace.
  delete env.PRIVATE_KEY // spawn-env: child cwd has no .env
  delete env.PRIVATE_KEY_PRODUCTION // spawn-env: child cwd has no .env
  // Deliberately malformed rather than merely unroutable: the driver spends its
  // 30 s server-selection budget on an unreachable host, where a URI it cannot
  // parse throws on construction, so a probe that gets past the gate dies at
  // once instead of hanging the suite.
  env.SC_MONGODB_URI = 'blocked-in-tests://no-store'
  env.MONGODB_URI = env.SC_MONGODB_URI
  if (options.environment === undefined) delete env.ENVIRONMENT
  else env.ENVIRONMENT = options.environment
  // the Tron funnel checks the ticket before the gate, so a probe without one
  // would never reach the gate at all
  env.SAFE_PROPOSAL_TICKET = 'EXSC-929'

  const result = spawnSync('bun', [options.cli, ...options.args], {
    cwd: options.repoRoot,
    encoding: 'utf8',
    env,
    timeout: TIMEOUT_MS,
    // Truncated output would hide a store breach from the tripwire below, and
    // report it as ENOBUFS instead, whatever order the checks run in.
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = `${result.stdout}${result.stderr}`
  assertChildIsUsable(result, output)

  return { output, status: result.status }
}

const runCli = (options: {
  diverge: boolean
  network: string
  calldata: Hex
  environment?: string
}): { output: string; status: number | null } =>
  spawnCli({
    cli: PROPOSE_CLI,
    repoRoot: makeRepo(options.diverge),
    environment: options.environment,
    args: [
      '--network',
      options.network,
      '--to',
      DIAMOND_ADDRESS,
      '--calldata',
      options.calldata,
      '--timelock',
      '--ticket',
      'EXSC-704',
    ],
  })

const GATE_REFUSAL = /Production deploy gate failed/

/**
 * What each funnel prints once it is past the gate, measured from a passing run
 * rather than assumed: the EVM one reads a signing key the harness withheld, and
 * the Tron one reaches the proposal store, whose URI the harness made
 * unparseable. Every absence assertion on these is paired with a positive
 * assertion in the corresponding pass case — a marker that never appears would
 * make the absence assertion prove nothing.
 */
const NEXT_STOP_EVM = 'Private key is missing'
// Owned by `mongodb-connection-string-url`, not this repo: if a bump rewords it,
// the paired pass-case assertion goes red first, so the suite reports it rather
// than quietly letting the refusal case go vacuous.
const NEXT_STOP_TRON = 'expected connection string to start with'
// `sendOrPropose` resolves its key through a different helper than the funnel, so
// it words the same failure differently. The `--ledger` clause is load-bearing:
// the bare "Missing <VAR> in environment" prefix is thrown on the direct-tx
// branch too, which returns before the gate, so a marker without it would be
// satisfied by a run that never reached the gate at all.
const NEXT_STOP_SEND_OR_PROPOSE = 'in environment. Set it, or pass --ledger'

const TRON_FACET = 'CalldataVerificationFacet'

/**
 * Builds a Tron-shaped repo: the funnel reads `deployments/<network>.json` and
 * `config/networks.json` from the cwd, while the gate's address attribution
 * comes from the real log through `getDeployments`. Copying the real files keeps
 * the two in agreement.
 * @param diverge - append an unmerged edit to the facet source
 * @returns the repository root and the facet's EVM-hex address
 */
const makeTronRepo = (
  diverge: boolean
): { repoRoot: string; facetAddressHex: Address } => {
  const repoRoot = makeRepo(false)
  mkdirSync(join(repoRoot, 'deployments'), { recursive: true })
  mkdirSync(join(repoRoot, 'config'), { recursive: true })
  for (const file of ['deployments/tron.json', 'config/networks.json'])
    copyFileSync(join(REPO_ROOT, file), join(repoRoot, file))

  const tronLog = JSON.parse(
    readFileSync(join(REPO_ROOT, 'deployments/tron.json'), 'utf8')
  ) as Record<string, string>

  // TronWeb's own converter, statically: a Tron address is a 0x41-prefixed
  // payload, and the cut carries the 20 bytes after that prefix
  const facetAddressHex = `0x${TronWeb.address
    .toHex(tronLog[TRON_FACET] as string)
    .slice(2)}` as Address

  const facetPath = join(repoRoot, `src/Facets/${TRON_FACET}.sol`)
  writeFileSync(
    facetPath,
    `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${TRON_FACET} {}\n`
  )
  const git = (...a: string[]) =>
    spawnSync('git', a, { cwd: repoRoot, encoding: 'utf8' })
  git('add', '.')
  git('commit', '-m', 'tron facet', '--no-gpg-sign')
  git('push', '-q', 'origin', 'HEAD:main')
  git('fetch', '-q', 'origin')

  if (diverge)
    writeFileSync(
      facetPath,
      `// SPDX-License-Identifier: LGPL-3.0-only\n/// @custom:version 1.0.0\ncontract ${TRON_FACET} { uint256 public unreviewed; }\n`
    )

  return { repoRoot, facetAddressHex }
}

describe('assertChildIsUsable ordering', () => {
  // Measured, not assumed: `spawnSync` with a `timeout` returns status=null,
  // signal=SIGTERM, error=ETIMEDOUT, and the stdout the child had already
  // written. That is the write-then-hang shape, so the store check has to
  // precede both.
  const timedOutAfterWriting = {
    error: Object.assign(new Error('spawnSync bun ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    }),
    signal: 'SIGTERM' as NodeJS.Signals,
  }

  it('reports the store violation, not the timeout, when a probe wrote and then hung', () => {
    expect(() =>
      assertChildIsUsable(
        timedOutAfterWriting,
        '\u2139 Network: tron\n\u2714 Proposal stored in MongoDB.\n'
      )
    ).toThrow(/reached a real proposal store/)
  })

  it('reports the spawn error when nothing was written', () => {
    expect(() =>
      assertChildIsUsable(timedOutAfterWriting, '\u2139 Network: tron')
    ).toThrow(/ETIMEDOUT/)
  })

  it('reports a kill with no spawn error as proving nothing', () => {
    expect(() =>
      assertChildIsUsable({ signal: 'SIGKILL' as NodeJS.Signals }, 'partial')
    ).toThrow(/proves nothing/)
  })

  it('accepts a child that ran to completion without storing anything', () => {
    expect(() =>
      assertChildIsUsable({ signal: null }, 'Production deploy gate failed')
    ).not.toThrow()
  })
})

describe('propose-to-safe-tron funnel deploy gate', () => {
  const runTron = (diverge: boolean) => {
    const { repoRoot, facetAddressHex } = makeTronRepo(diverge)
    const tronLog = JSON.parse(
      readFileSync(join(repoRoot, 'deployments/tron.json'), 'utf8')
    ) as Record<string, string>

    return spawnCli({
      cli: TRON_CLI,
      repoRoot,
      args: [
        '--network',
        'tron',
        '--to',
        tronLog.LiFiDiamond as string,
        '--calldata',
        addCut(facetAddressHex),
        '--timelock',
        // a key generated per run, so nothing signable is written down; it never
        // signs anything either, the gate refuses first
        '--privateKey',
        generatePrivateKey(),
      ],
    })
  }

  it(
    'refuses a diverged facet addition before the Timelock is read',
    () => {
      const result = runTron(true)

      expect(result.output).toMatch(GATE_REFUSAL)
      expect(result.output).toContain(TRON_FACET)
      expect(result.status).not.toBe(0)
      // The store is the last step before a production write, so its absence is
      // what makes "the refusal came first" mean anything here
      expect(result.output).not.toContain(NEXT_STOP_TRON)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'lets an unchanged facet addition past the gate',
    () => {
      const result = runTron(false)

      expect(result.output).not.toMatch(GATE_REFUSAL)
      expect(result.output).toContain('Production deploy gate passed')
      // what makes the refusal case's absence assertion mean anything
      expect(result.output).toContain(NEXT_STOP_TRON)
    },
    CASE_TIMEOUT_MS
  )
})

describe('propose-to-safe funnel deploy gate', () => {
  it(
    'refuses a diverged facet addition before the Safe client is initialised',
    () => {
      const result = runCli({
        diverge: true,
        network: 'mainnet',
        calldata: ADD_CUT,
        environment: 'production',
      })

      expect(result.output).toMatch(GATE_REFUSAL)
      expect(result.output).toContain(FACET)
      expect(result.status).not.toBe(0)
      // the refusal has to land before the key is read, which is the first step
      // towards a signature. Verified by deleting the gate call: this marker then
      // appears, so its absence is not a vacuous assertion about text that never
      // shows up at all
      expect(result.output).not.toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'lets an unchanged facet addition past the gate',
    () => {
      const result = runCli({
        diverge: false,
        network: 'mainnet',
        calldata: ADD_CUT,
      })

      expect(result.output).not.toMatch(GATE_REFUSAL)
      expect(result.output).toContain('Production deploy gate passed')
      // what makes every absence assertion on this marker mean anything
      expect(result.output).toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'skips the gate on a testnet even with a diverged facet',
    () => {
      const result = runCli({
        diverge: true,
        network: 'sepolia',
        calldata: ADD_CUT,
      })

      expect(result.output).not.toMatch(GATE_REFUSAL)
      expect(result.output).not.toContain('Production deploy gate passed')
      // a skip has to let the run continue. Without this the two absence
      // assertions above would also pass on a run that died before the gate
      expect(result.output).toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'cannot be switched off by an ambient ENVIRONMENT=staging',
    () => {
      const result = runCli({
        diverge: true,
        network: 'mainnet',
        calldata: ADD_CUT,
        environment: 'staging',
      })

      expect(result.output).toMatch(GATE_REFUSAL)
      expect(result.output).not.toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'refuses with ENVIRONMENT unset, so an unset environment is not an off-switch either',
    () => {
      const result = runCli({
        diverge: true,
        network: 'mainnet',
        calldata: ADD_CUT,
      })

      expect(result.output).toMatch(GATE_REFUSAL)
      expect(result.output).not.toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'does not gate a proposal that installs no facet code',
    () => {
      const result = runCli({
        diverge: true,
        network: 'mainnet',
        calldata: '0xdeadbeef' as Hex,
      })

      expect(result.output).not.toMatch(GATE_REFUSAL)
      expect(result.output).not.toContain('Production deploy gate passed')
      // the skip has to let the run continue rather than end it quietly
      expect(result.output).toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )
})

describe('sendOrPropose (TypeScript) funnel deploy gate', () => {
  // The third proposer. It signs and stores without either propose-to-safe
  // funnel, so its gate call is inline and nothing else proves it is there —
  // removing it only breaks the type checker, which is not a test.
  const PROBE = `
import { sendOrPropose } from ${JSON.stringify(
    join(REPO_ROOT, 'script/safe/safeScriptHelpers')
  )}
import { EnvironmentEnum } from ${JSON.stringify(
    join(REPO_ROOT, 'script/common/types')
  )}
try {
  await sendOrPropose({
    calldata: process.argv[2],
    network: 'mainnet',
    environment: EnvironmentEnum.production,
    diamondAddress: ${JSON.stringify(DIAMOND_ADDRESS)},
    signing: {},
  })
  console.log('GATE_NOT_REACHED')
} catch (error) {
  console.log((error as Error).message)
}
`

  const runProbe = (diverge: boolean): string => {
    const repoRoot = makeRepo(diverge)
    const probe = join(repoRoot, 'probe.ts')
    writeFileSync(probe, PROBE)
    return spawnCli({
      cli: probe,
      args: [ADD_CUT],
      repoRoot,
      environment: 'production',
    }).output
  }

  it(
    'refuses a diverged facet addition before the Safe client is initialised',
    () => {
      const output = runProbe(true)

      expect(output).toMatch(GATE_REFUSAL)
      expect(output).toContain(FACET)
      expect(output).not.toContain('GATE_NOT_REACHED')
      // this is what it prints once past the gate, so its absence has teeth
      expect(output).not.toContain(NEXT_STOP_SEND_OR_PROPOSE)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'lets an unchanged facet addition past the gate',
    () => {
      const output = runProbe(false)

      expect(output).not.toMatch(GATE_REFUSAL)
      expect(output).toContain('Production deploy gate passed')
      // pairs the refusal case's absence assertion with the marker appearing
      expect(output).toContain(NEXT_STOP_SEND_OR_PROPOSE)
    },
    CASE_TIMEOUT_MS
  )
})
