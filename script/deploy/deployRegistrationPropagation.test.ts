/**
 * Regression tests for the deploy pipeline's failure propagation.
 *
 * A production deploy that lands the contract on-chain but fails to register it in the
 * diamond (e.g. the Safe proposal step cannot reach MongoDB) used to be reported as
 * "OK" with exit code 0, so nothing driving deployContractToNetworks.sh
 * non-interactively could tell it apart from a completed rollout.
 *
 * Each case sources the real shell function and stubs only its dependencies, so the
 * assertions are about return-code propagation, not about any network being reachable.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
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

let workDir: string

// Neutralize the sourcing the functions under test do at call time (.env,
// helperFunctions.sh, ...) so the harness controls every dependency.
const STUB_PRELUDE = `
source() { return 0; }
error() { echo "[error] $*"; }
warning() { echo "[warning] $*"; }
echoDebug() { :; }
getFileSuffix() { echo ""; }
`

/**
 * Run a bash harness and return its trimmed stdout.
 *
 * @param body - harness script body
 * @param env - extra environment variables for the harness
 * @param cwd - working directory to run in (defaults to the temp deployments fixture)
 */
function runHarness(
  body: string,
  env: Record<string, string> = {},
  cwd: string = workDir
): string {
  const harnessPath = join(
    workDir,
    `harness-${Math.random().toString(36).slice(2)}.sh`
  )
  writeFileSync(harnessPath, body)
  return execFileSync('bash', [harnessPath], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, REPO_ROOT, ...env },
  }).trim()
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'deploy-propagation-'))
  mkdirSync(join(workDir, 'deployments'))
  // deployment log the functions under test read the diamond/contract address from
  writeFileSync(
    join(workDir, 'deployments', 'testnet.json'),
    JSON.stringify({
      LiFiDiamond: '0x1111111111111111111111111111111111111111',
      OutputValidator: '0x2222222222222222222222222222222222222222',
      TokenWrapper: '0x3333333333333333333333333333333333333333',
    })
  )
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('diamondUpdatePeriphery', () => {
  const harness = (registerRc: string) => `
    source "$REPO_ROOT/script/tasks/diamondUpdatePeriphery.sh"
    ${STUB_PRELUDE}
    isTestnetNetwork() { return 1; }
    getPeripheryAddressFromDiamond() { echo "0x0000000000000000000000000000000000000000"; }
    saveDiamondPeriphery() { return 0; }
    register() { return ${registerRc}; }
    diamondUpdatePeriphery testnet production LiFiDiamond false false OutputValidator >/dev/null
    echo "rc=$?"
  `

  it('returns non-zero when registering the contract fails', () => {
    expect(runHarness(harness('1'))).toBe('rc=1')
  })

  it('returns zero when the contract is registered', () => {
    expect(runHarness(harness('0'))).toBe('rc=0')
  })

  // batch mode (UPDATE_ALL=true): LAST_CALL is sticky, so a later contract's
  // successful registration must not mask an earlier contract's failure
  const batchHarness = `
    source "$REPO_ROOT/script/tasks/diamondUpdatePeriphery.sh"
    ${STUB_PRELUDE}
    isTestnetNetwork() { return 1; }
    getIncludedPeripheryContractsArray() { echo "OutputValidator TokenWrapper"; }
    getPeripheryAddressFromDiamond() { echo "0x0000000000000000000000000000000000000000"; }
    saveDiamondPeriphery() { return 0; }
    register() { [ "$3" != "OutputValidator" ]; }
    diamondUpdatePeriphery testnet production LiFiDiamond true false "" >/dev/null
    echo "rc=$?"
  `

  it('stays failed when an earlier contract fails and a later one succeeds', () => {
    expect(runHarness(batchHarness)).toBe('rc=1')
  })
})

describe('deployAndAddContractToDiamond (periphery path)', () => {
  const harness = `
    source script/helperFunctions.sh >/dev/null 2>&1
    deploySingleContract() { return "$DEPLOY_RC"; }
    diamondUpdatePeriphery() { return "$UPDATE_RC"; }
    deployAndAddContractToDiamond testnet production OutputValidator LiFiDiamond 1.0.0 >/dev/null 2>&1
    echo "rc=$?"
  `

  // helperFunctions.sh resolves config/ paths relative to the repo root
  const run = (deployRc: string, updateRc: string) =>
    runHarness(harness, { DEPLOY_RC: deployRc, UPDATE_RC: updateRc }, REPO_ROOT)

  it('fails when the contract deployed but the diamond registration did not', () => {
    expect(run('0', '1')).toBe('rc=1')
  })

  it('fails when the deployment itself failed', () => {
    expect(run('1', '0')).toBe('rc=1')
  })

  it('succeeds only when both the deployment and the registration succeeded', () => {
    expect(run('0', '0')).toBe('rc=0')
  })
})

describe('deployFacetAndAddToDiamond', () => {
  // Records whether the facet-cut task was sourced and substitutes a stub for it, so the
  // test fails if the source line is dropped again (the cut would then silently rely on
  // the caller having sourced script/tasks/*.sh).
  const harness = (updateRc: string) => `
    source "$REPO_ROOT/script/deploy/deployFacetAndAddToDiamond.sh"
    SOURCED_UPDATE_FACET_TASK=0
    source() {
      case "$1" in
        script/tasks/diamondUpdateFacet.sh)
          SOURCED_UPDATE_FACET_TASK=1
          diamondUpdateFacet() { return ${updateRc}; }
          ;;
      esac
      return 0
    }
    error() { echo "[error] $*"; }
    warning() { echo "[warning] $*"; }
    echoDebug() { :; }
    getFileSuffix() { echo ""; }
    deploySingleContract() { return 0; }
    deployFacetAndAddToDiamond testnet production TestFacet LiFiDiamond 1.0.0 >/dev/null 2>&1
    echo "rc=$? sourced=$SOURCED_UPDATE_FACET_TASK"
  `

  it('sources diamondUpdateFacet.sh instead of relying on the caller', () => {
    expect(runHarness(harness('0'))).toBe('rc=0 sourced=1')
  })

  it('returns non-zero when the diamond cut fails', () => {
    expect(runHarness(harness('1'))).toBe('rc=1 sourced=1')
  })
})

describe('deployToNetworkWorker result file', () => {
  // Sources only the worker (the script's top-level framework loading is guarded by a
  // repo-root check and would run the whole deploy), then drives it with a stubbed
  // deployAndAddContractToDiamond.
  const harness = `
    eval "$(sed -n '/^function deployToNetworkWorker()/,/^}/p' "$REPO_ROOT/script/deploy/deployContractToNetworks.sh")"
    ${STUB_PRELUDE}
    success() { echo "[success] $*"; }
    checkRequiredVariablesInDotEnv() { return 0; }
    getDeployerBalance() { echo "1"; }
    deployAndAddContractToDiamond() { return "$DEPLOY_RC"; }
    mkdir -p results
    deployToNetworkWorker testnet production OutputValidator 1.0.0 results >/dev/null
    echo "rc=$? result=$(cat results/testnet)"
  `

  it('does not write OK when the diamond registration failed', () => {
    expect(runHarness(harness, { DEPLOY_RC: '1' })).toBe('rc=1 result=FAILED')
  })

  it('writes OK when deployment and registration both succeeded', () => {
    expect(runHarness(harness, { DEPLOY_RC: '0' })).toBe('rc=0 result=OK')
  })
})
