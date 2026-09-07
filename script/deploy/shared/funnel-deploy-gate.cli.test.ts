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
 * Runs the real propose CLI against a throwaway repo.
 * @param options - repo divergence, target network, and the calldata to propose
 * @returns the CLI's combined output and exit status
 */
/**
 * Runs a real propose CLI in a throwaway repo.
 * @param options - which CLI, its arguments, and the repo to run it in
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
  delete env.PRIVATE_KEY
  delete env.PRIVATE_KEY_PRODUCTION
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
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // A timeout-killed child is not a result: without this, every absence
  // assertion below would pass on a run that was killed before printing.
  if (result.signal)
    throw new Error(
      `child was killed by ${result.signal} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )

  const output = `${result.stdout}${result.stderr}`
  // Load-bearing, not belt-and-braces: no case here may reach a real proposal
  // store, whichever side of the gate it lands on. All three funnels word their
  // success differently — "Proposal stored in MongoDB" (Tron), "Transaction
  // successfully stored in MongoDB" (EVM), "proposed and stored in MongoDB"
  // (sendOrPropose) — so matching one of them protects one third of the cases.
  if (/stored in mongodb/i.test(output))
    throw new Error(
      'a probe reached a real proposal store — the child environment is not isolated'
    )

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
 * The first thing each funnel prints once it is past the gate — the EVM one
 * reads the signing key, the Tron one gets as far as the ticket check in the
 * storage funnel. Both are reached only because every signing credential is
 * withheld, and each is asserted absent in the refusal cases.
 */
const NEXT_STOP_EVM = 'Private key is missing'
const NEXT_STOP_TRON = 'No Linear ticket supplied'

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
      // NEXT_STOP is what this run prints once it is past the gate, verified by
      // deleting the gate call: its absence is what makes "the refusal came first"
      // mean anything, and it is a real marker rather than an invented one
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
      expect(output).not.toContain(NEXT_STOP_EVM)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'lets an unchanged facet addition past the gate',
    () => {
      const output = runProbe(false)

      expect(output).not.toMatch(GATE_REFUSAL)
      expect(output).toContain('Production deploy gate passed')
    },
    CASE_TIMEOUT_MS
  )
})
