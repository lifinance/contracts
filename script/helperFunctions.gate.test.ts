/**
 * The deploy gate on the bash `sendOrPropose` direct-broadcast route.
 *
 * `assertFunnelDeployGate` runs inside the proposal funnels, which this route
 * never enters, so the branch that broadcasts straight from the deployer key
 * needs the same policy applied from the shell. These cases pin the condition
 * under which it runs, the fact that it is wired ahead of the broadcast rather
 * than merely defined, and that the CLI it calls really does recover a cut out
 * of real calldata against a real production deployment log.
 */
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, zeroAddress } from 'viem'

import { DIRECT_BROADCAST_GATE_ALLOWED } from './deploy/shared/assert-direct-broadcast-gate'
import { DIAMOND_CUT_ABI } from './deploy/shared/constants'

const REPO_ROOT = join(import.meta.dir, '..')
const HELPERS = join(REPO_ROOT, 'script', 'helperFunctions.sh')
const GATE_CLI = join(
  'script',
  'deploy',
  'shared',
  'assert-direct-broadcast-gate.ts'
)

/** A mainnet network whose production deployment log this repo carries. */
const MAINNET = 'arbitrum'
const TESTNET = 'sepolia'

/**
 * An address no production log records. Deliberately not the zero address,
 * which a `Remove` cut carries and the gate drops before attribution.
 */
const UNRECORDED_FACET = '0x00000000000000000000000000000000deadbeef'

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'send-or-propose-gate-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Encodes a `diamondCut` installing one facet address.
 * @param facetAddress - the address whose code the cut would run
 * @param action - `LibDiamond.FacetCutAction`: Add=0, Replace=1, Remove=2
 */
const cutCalldata = (facetAddress: string, action = 0): string =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [
        {
          facetAddress: facetAddress as `0x${string}`,
          action,
          functionSelectors: ['0x12345678'],
        },
      ],
      zeroAddress,
      '0x',
    ],
  })

/**
 * Run a bash harness and return its trimmed stdout and stderr.
 * @param body - harness script body
 */
const runHarness = (body: string): string => {
  const harnessPath = join(
    workDir,
    `harness-${Math.random().toString(36).slice(2)}.sh`
  )
  writeFileSync(harnessPath, body)
  return execFileSync('bash', [harnessPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, HELPERS },
  }).trim()
}

/**
 * Loads the real helper definitions without their top-level side effects.
 *
 * A function named `source` shadows the builtin the file uses to pull in `.env`
 * and its siblings, while `.` — a separate builtin — still loads the file
 * itself. So the harness gets the real `sendOrPropose` and no secrets.
 */
const LOAD_HELPERS = `
  source() { return 0; }
  getZkToolchainPin() { echo ""; }
  . "$HELPERS"
`

describe('assertDirectBroadcastCalldataGate', () => {
  /**
   * Asks the real gate for a verdict with the CLI stubbed, so what is asserted
   * is whether it delegates at all, not what the CLI would decide.
   * @param network - network handed to the gate
   * @param environment - ENVIRONMENT handed to the gate
   * @param gateRc - exit status the stubbed CLI reports
   */
  const decide = (network: string, environment: string, gateRc = '0') =>
    runHarness(`
      ${LOAD_HELPERS}
      isTestnetNetwork() { [[ "$1" == "${TESTNET}" ]]; }
      error() { echo "[error] $*"; }
      bunx() { echo "GATE_RAN $*"; echo "${DIRECT_BROADCAST_GATE_ALLOWED}"; return ${gateRc}; }
      assertDirectBroadcastCalldataGate "${network}" "${environment}" "0xdeadbeef"
      echo "rc=$?"
    `)

  it('runs on a production mainnet network', () => {
    const out = decide(MAINNET, 'production')
    expect(out).toContain('GATE_RAN')
    expect(out).toContain(`--network ${MAINNET} --calldata 0xdeadbeef`)
    expect(out).toContain('rc=0')
  })

  it.each([['prod'], [''], ['PRODUCTION'], ['STAGING']])(
    'runs for ENVIRONMENT=%p, which still gets the production key',
    (environment) => {
      // `getPrivateKey` hands out the production key for every ENVIRONMENT that
      // does not contain "staging", so the gate has to be at least as broad.
      expect(decide(MAINNET, environment)).toContain('GATE_RAN')
    }
  )

  it('runs for ENVIRONMENT=staging2, which gets the STAGING key', () => {
    // `getPrivateKey` matches "staging" as a substring, so this one is a staging
    // key — but the gate compares the exact string, so it is gated anyway. The
    // gate being broader than the key can only cost a false refusal, whereas the
    // reverse would be a production broadcast nobody checked. Substring-matching
    // the gate is the mutation this case exists to kill.
    expect(decide(MAINNET, 'staging2')).toContain('GATE_RAN')
  })

  it('skips on staging, saying so', () => {
    const out = decide(MAINNET, 'staging')
    expect(out).not.toContain('GATE_RAN')
    expect(out).toContain('skipped: staging environment')
    expect(out).toContain('rc=0')
  })

  it('skips on a testnet, saying so', () => {
    const out = decide(TESTNET, 'production')
    expect(out).not.toContain('GATE_RAN')
    expect(out).toContain(`skipped: ${TESTNET} is a testnet`)
    expect(out).toContain('rc=0')
  })

  it('refuses when the CLI reports failures', () => {
    const out = decide(MAINNET, 'production', '1')
    expect(out).toContain('GATE_RAN')
    expect(out).toContain('rc=1')
  })

  it('refuses when the CLI exits 0 without an allow token', () => {
    const out = runHarness(`
      ${LOAD_HELPERS}
      isTestnetNetwork() { [[ "$1" == "${TESTNET}" ]]; }
      error() { echo "[error] $*"; }
      bunx() { echo "GATE_RAN $*"; return 0; }
      assertDirectBroadcastCalldataGate "${MAINNET}" "production" "0xdeadbeef"
      echo "rc=$?"
    `)

    expect(out).toContain('GATE_RAN')
    expect(out).toContain('no allow token')
    expect(out).toContain('rc=1')
  })

  it('refuses a token that only appears inside another line', () => {
    // CALLDATA is the caller's, so a CLI that never gated and merely echoed its
    // arguments would satisfy a substring match on the captured output.
    const out = runHarness(`
      ${LOAD_HELPERS}
      isTestnetNetwork() { [[ "$1" == "${TESTNET}" ]]; }
      error() { echo "[error] $*"; }
      bunx() { echo "refused: $*"; return 0; }
      assertDirectBroadcastCalldataGate "${MAINNET}" "production" "0x${DIRECT_BROADCAST_GATE_ALLOWED}"
      echo "rc=$?"
    `)

    expect(out).toContain(DIRECT_BROADCAST_GATE_ALLOWED)
    expect(out).toContain('no allow token')
    expect(out).toContain('rc=1')
  })

  it('refuses a token written to stderr rather than stdout', () => {
    // `runHarness` inherits stderr, so the token below never reaches the capture
    // at all — which is the point: the gate used to merge the two streams and
    // would have read this as consent.
    const out = runHarness(`
      ${LOAD_HELPERS}
      isTestnetNetwork() { [[ "$1" == "${TESTNET}" ]]; }
      error() { echo "[error] $*"; }
      bunx() { echo "GATE_RAN"; echo "${DIRECT_BROADCAST_GATE_ALLOWED}" >&2; return 0; }
      assertDirectBroadcastCalldataGate "${MAINNET}" "production" "0xdeadbeef"
      echo "rc=$?"
    `)

    expect(out).toContain('GATE_RAN')
    expect(out).toContain('no allow token')
    expect(out).toContain('rc=1')
  })
})

/** Printed only by the branch that broadcasts instead of proposing. */
const BROADCAST_MARKER = 'SENT_RAW'
/** Printed only by the branch that creates a Safe proposal. */
const PROPOSE_MARKER = 'PROPOSED'

describe('placement inside sendOrPropose', () => {
  /**
   * Drives the real function with every downstream dependency stubbed, so what
   * is asserted is the order of the calls it makes rather than any network being
   * reachable. `SENT_RAW` is the marker for the irreversible step: a refusal
   * that lands after it would be worthless.
   */
  const harness = (options: {
    environment: string
    directFlag: string
    gateRc: string
    network?: string
  }) => `
    ${LOAD_HELPERS}
    error() { echo "[error] $*"; }
    isTestnetNetwork() { [[ "$1" == "${TESTNET}" ]]; }
    isTronNetwork() { return 1; }
    getPrivateKey() { echo "0xkey"; }
    universalCast() { echo "${BROADCAST_MARKER} $1"; return 0; }
    bunx() { echo "${PROPOSE_MARKER} $*"; return 0; }
    assertDirectBroadcastCalldataGate() { echo "GATE_CALLED env=$2 calldata=$3"; return ${
      options.gateRc
    }; }
    export SEND_PROPOSALS_DIRECTLY_TO_DIAMOND="${options.directFlag}"
    sendOrPropose "${options.network ?? MAINNET}" "${
    options.environment
  }" 0xdiamond 0xabcdef false 2>&1
    echo "rc=$?"
  `

  it('gates the direct-broadcast route before anything is broadcast', () => {
    const out = runHarness(
      harness({ environment: 'production', directFlag: 'true', gateRc: '1' })
    )

    expect(out).toContain('GATE_CALLED')
    expect(out).not.toContain(BROADCAST_MARKER)
    expect(out).toContain('rc=1')
  })

  it('lets the direct-broadcast route through when the gate passes', () => {
    const out = runHarness(
      harness({ environment: 'production', directFlag: 'true', gateRc: '0' })
    )

    // proves the passing case really is the direct-broadcast branch, so the
    // refusal case above is not merely a run that never got here
    expect(out).toContain('GATE_CALLED')
    expect(out).toContain(`${BROADCAST_MARKER} sendRaw`)
    expect(out).toContain('rc=0')
  })

  it('hands the gate the calldata that is about to be broadcast', () => {
    const out = runHarness(
      harness({ environment: 'production', directFlag: 'true', gateRc: '0' })
    )

    // the gate reads the cut out of these bytes, so a call site passing the
    // target, or an empty string, would gate nothing while still logging a pass
    expect(out).toContain('calldata=0xabcdef')
  })

  it('does not call it on the Safe-proposal route, which the funnel gates', () => {
    const out = runHarness(
      harness({ environment: 'production', directFlag: '', gateRc: '1' })
    )

    // a second gate on this route is exactly what D9 forbids
    expect(out).not.toContain('GATE_CALLED')
    // asserting the branch, not merely that something ran: with `gateRc` set to
    // refuse, an absence assertion alone would also pass on a run that took the
    // direct branch and was refused there
    expect(out).toContain(PROPOSE_MARKER)
    expect(out).not.toContain(BROADCAST_MARKER)
  })

  it('gates the testnet direct route too, where the CLI makes the skip decision', () => {
    const out = runHarness(
      harness({
        environment: 'production',
        directFlag: '',
        gateRc: '0',
        network: TESTNET,
      })
    )

    expect(out).toContain('GATE_CALLED')
    expect(out).toContain(`${BROADCAST_MARKER} sendRaw`)
  })

  it('passes the environment through, so the gate sees what the key sees', () => {
    const out = runHarness(
      harness({ environment: 'staging', directFlag: '', gateRc: '0' })
    )

    expect(out).toContain('GATE_CALLED env=staging')
  })
})

describe('assert-direct-broadcast-gate CLI against real repo data', () => {
  /**
   * Spawns the real CLI in the real checkout, so the deployment log and network
   * config it reads are the ones a deploy would read.
   * @param network - network to gate against
   * @param calldata - calldata the gate has to read a cut out of
   */
  const run = (network: string, calldata: string) => {
    // `bun test` sets NODE_ENV=test on this process; consola then silences
    // info/success in the child, so the allow-path reasons these cases pin
    // would arrive as "" even though the gate exited 0. Mirror
    // funnel-deploy-gate.cli.test.ts: drop NODE_ENV so the child behaves as a
    // real CLI.
    const env = { ...(process.env as Record<string, string>) }
    delete env.NODE_ENV
    return spawnSync(
      'bunx',
      ['tsx', GATE_CLI, '--network', network, '--calldata', calldata],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  }

  it('refuses a cut installing an address the production log does not record', () => {
    const { status, stdout, stderr } = run(
      MAINNET,
      cutCalldata(UNRECORDED_FACET)
    )

    expect(status).toBe(1)
    expect(`${stdout}${stderr}`).toContain('cannot attribute to a facet')
    expect(`${stdout}${stderr}`.toLowerCase()).toContain(
      UNRECORDED_FACET.toLowerCase()
    )
    expect(`${stdout}${stderr}`).not.toContain(DIRECT_BROADCAST_GATE_ALLOWED)
  })

  it('refuses calldata it cannot read as a cut', () => {
    // Every selector and offset is read positionally off a `0x` prefix, so a
    // skip here would be a pass
    const { status, stdout, stderr } = run(MAINNET, 'not-hex')

    expect(status).toBe(1)
    expect(`${stdout}${stderr}`).toContain('not well-formed calldata')
    expect(`${stdout}${stderr}`).not.toContain(DIRECT_BROADCAST_GATE_ALLOWED)
  })

  it('allows calldata that installs no facet code', () => {
    // The paired positive: the gate cannot degrade into refusing everything, and
    // this route carries far more config calls than cuts
    const transferOwnership = encodeFunctionData({
      abi: [
        {
          inputs: [{ name: '_newOwner', type: 'address' }],
          name: 'transferOwnership',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ] as const,
      functionName: 'transferOwnership',
      args: [UNRECORDED_FACET as `0x${string}`],
    })

    const { status, stdout, stderr } = run(MAINNET, transferOwnership)

    expect(status).toBe(0)
    expect(`${stdout}${stderr}`).toContain('installs facet code')
    expect(`${stdout}${stderr}`).toContain(DIRECT_BROADCAST_GATE_ALLOWED)
  })

  it('allows a cut on a testnet, saying why', () => {
    const { status, stdout, stderr } = run(
      TESTNET,
      cutCalldata(UNRECORDED_FACET)
    )

    expect(status).toBe(0)
    expect(`${stdout}${stderr}`).toContain('is a testnet')
    expect(`${stdout}${stderr}`).toContain(DIRECT_BROADCAST_GATE_ALLOWED)
  })

  it('still runs when its own path is reached through a symlink', () => {
    // tsx realpaths `import.meta.url` but not argv[1], so an entrypoint check
    // that compares them unresolved is true only in an unsymlinked checkout.
    // Grepping the source cannot tell the two compares apart; reaching the CLI
    // through a link can, and a no-op CLI would exit 0 with no output.
    const linkRoot = mkdtempSync(join(tmpdir(), 'gate-symlink-'))
    const linked = join(linkRoot, 'shared')

    try {
      symlinkSync(join(REPO_ROOT, 'script/deploy/shared'), linked, 'dir')

      const env = { ...(process.env as Record<string, string>) }
      delete env.NODE_ENV
      const { status, stdout, stderr } = spawnSync(
        'bunx',
        [
          'tsx',
          join(linked, 'assert-direct-broadcast-gate.ts'),
          '--network',
          MAINNET,
          '--calldata',
          'not-hex',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )

      expect(status).toBe(1)
      expect(`${stdout}${stderr}`).toContain('not well-formed calldata')
      expect(`${stdout}${stderr}`).not.toContain(DIRECT_BROADCAST_GATE_ALLOWED)
    } finally {
      rmSync(linkRoot, { recursive: true, force: true })
    }
  })
})
