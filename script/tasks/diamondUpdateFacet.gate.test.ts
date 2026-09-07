/**
 * The deploy gate on the direct-broadcast route.
 *
 * `assertFunnelDeployGate` only sees calldata that reaches a Safe proposal, so
 * the route that broadcasts a cut straight from the deployer key needs its own
 * gate. These cases pin both halves: the condition under which it runs, and the
 * fact that it is wired ahead of the broadcast rather than merely defined.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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

const REPO_ROOT = join(import.meta.dir, '..', '..')
const TASK = join(REPO_ROOT, 'script', 'tasks', 'diamondUpdateFacet.sh')

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'diamond-update-gate-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Run a bash harness and return its trimmed stdout and stderr.
 * @param body - harness script body
 * @param env - extra environment variables for the harness
 */
const runHarness = (body: string, env: Record<string, string> = {}): string => {
  const harnessPath = join(
    workDir,
    `harness-${Math.random().toString(36).slice(2)}.sh`
  )
  writeFileSync(harnessPath, body)
  return execFileSync('bash', [harnessPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, REPO_ROOT, TASK, ...env },
  }).trim()
}

describe('assertDirectBroadcastDeployGate', () => {
  // Loads only the gate helper, so the decision is exercised without the
  // hundreds of lines of forge plumbing that surround its call site.
  const decide = (
    network: string,
    environment: string,
    contract = 'UpdateTestFacet',
    gateRc = '0'
  ) =>
    runHarness(
      `
      eval "$(sed -n '/^assertDirectBroadcastDeployGate()/,/^}/p' "$TASK")"
      isTestnetNetwork() { [[ "$1" == "sepolia" ]]; }
      error() { echo "[error] $*"; }
      bunx() { echo "GATE_RAN $*"; return ${gateRc}; }
      git() { echo "some-branch"; }
      assertDirectBroadcastDeployGate "${network}" "${environment}" "${contract}"
      echo "rc=$?"
    `
    )

  it('runs on a production mainnet network', () => {
    const out = decide('mainnet', 'production')
    expect(out).toContain('GATE_RAN')
    expect(out).toContain('--facets TestFacet')
    expect(out).toContain('rc=0')
  })

  it.each([['prod'], [''], ['PRODUCTION'], ['STAGING']])(
    'runs for ENVIRONMENT=%p, which still gets the production key',
    (environment) => {
      // `getPrivateKey` hands out the production key for every ENVIRONMENT that
      // does not contain "staging", so the gate has to be at least as broad.
      expect(decide('mainnet', environment)).toContain('GATE_RAN')
    }
  )

  it('runs for ENVIRONMENT=staging2, which gets the STAGING key', () => {
    // The other half of the argument, and the load-bearing case: `getPrivateKey`
    // matches "staging" as a substring, so this one is a staging key — but the
    // gate compares the exact string, so it is gated anyway. That is deliberate:
    // the gate being broader than the key can only cost a false refusal, whereas
    // the reverse would be a production deploy nobody checked. Substring-matching
    // the gate is the mutation this case exists to kill.
    expect(decide('mainnet', 'staging2')).toContain('GATE_RAN')
  })

  it('does not run on staging', () => {
    const out = decide('mainnet', 'staging')
    expect(out).not.toContain('GATE_RAN')
    expect(out).toContain('rc=0')
  })

  it('does not run on a testnet', () => {
    const out = decide('sepolia', 'production')
    expect(out).not.toContain('GATE_RAN')
    expect(out).toContain('rc=0')
  })

  it('refuses when the gate reports failures', () => {
    const out = decide('mainnet', 'production', 'UpdateTestFacet', '1')
    expect(out).toContain('GATE_RAN')
    expect(out).toContain('rc=1')
  })

  it('expands UpdateCoreFacets to the whole coreFacets list', () => {
    const out = decide('mainnet', 'production', 'UpdateCoreFacets')
    expect(out).toContain('GATE_RAN')
    // read from the real config rather than a fixture, so a rename is caught
    expect(out).toMatch(/--facets [A-Za-z]*Facet/)
    expect(out).not.toContain('--facets CoreFacets')
  })
})

/** Printed only by the branch that broadcasts instead of proposing. */
const DIRECT_BRANCH_MARKER =
  'Sending diamondCut transaction directly to diamond'

describe('placement inside diamondUpdateFacet', () => {
  /**
   * Drives the real function with every downstream dependency stubbed, so what
   * is asserted is the order of the calls it makes rather than any network
   * being reachable. `RAN_FORGE` is the marker for the irreversible step: a
   * refusal that lands after it would be worthless.
   */
  const harness = (options: {
    environment: string
    directFlag: string
    gateRc: string
    network?: string
  }) => `
    source "$TASK"
    source() { return 0; }
    error() { echo "[error] $*"; }
    warning() { :; }
    echoDebug() { :; }
    getFileSuffix() { echo ""; }
    checkIfFileExists() { return 0; }
    isZkEvmNetwork() { return 1; }
    isTestnetNetwork() { [[ "$1" == "sepolia" ]]; }
    networkSupportsEip1559() { return 0; }
    getSkipSimulationFlag() { echo ""; }
    getPrivateKey() { echo "0xkey"; }
    getDeployerAddress() { echo "0xdeployer"; }
    cast() { echo "0xdeployer"; }
    jq() { echo "0xdiamond"; }
    saveDiamondFacets() { return 0; }
    updateDiamondLogs() { return 0; }
    executeAndParse() { echo "RAN_FORGE"; RETURN_CODE=0; RAW_RETURN_DATA='{"returns":{"facets":{"value":"{}"}}}'; return 0; }
    assertDirectBroadcastDeployGate() { echo "GATE_CALLED env=$2"; return ${
      options.gateRc
    }; }
    DEPLOY_SCRIPT_DIRECTORY="script/deploy/facets/"
    MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=1
    export SEND_PROPOSALS_DIRECTLY_TO_DIAMOND="${options.directFlag}"
    diamondUpdateFacet "${options.network ?? 'mainnet'}" "${
    options.environment
  }" LiFiDiamond UpdateTestFacet true 2>&1
    echo "rc=$?"
  `

  it('gates the direct-broadcast route before forge is invoked', () => {
    const out = runHarness(
      harness({ environment: 'production', directFlag: 'true', gateRc: '1' })
    )

    expect(out).toContain('GATE_CALLED')
    // the whole point: the refusal precedes the broadcast. It also precedes the
    // branch itself, which is why the branch marker is asserted in the
    // pass case below rather than here
    expect(out).not.toContain(DIRECT_BRANCH_MARKER)
    expect(out).not.toContain('RAN_FORGE')
    expect(out).toContain('rc=1')
  })

  it('lets the direct-broadcast route through when the gate passes', () => {
    const out = runHarness(
      harness({ environment: 'production', directFlag: 'true', gateRc: '0' })
    )

    expect(out).toContain('GATE_CALLED')
    // proves the passing case really is the direct-broadcast branch, so the
    // refusal case above is not merely a run that never got here
    expect(out).toContain(DIRECT_BRANCH_MARKER)
    expect(out).toContain('RAN_FORGE')
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
    expect(out).not.toContain(DIRECT_BRANCH_MARKER)
    expect(out).toContain('RAN_FORGE')
  })

  it('passes the environment through, so the helper sees what the key sees', () => {
    const out = runHarness(
      harness({ environment: 'staging', directFlag: '', gateRc: '0' })
    )

    expect(out).toContain('GATE_CALLED env=staging')
  })
})
