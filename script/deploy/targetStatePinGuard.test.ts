/**
 * Tests for the deploy-time target-state pin guard.
 *
 * `_targetState.json` declares which contracts belong on a network; the value is
 * `latest` (follow the repo) unless the network is deliberately pinned. A pin cannot
 * select an older build — `deploySingleContract` always compiles what the repo has —
 * so the only thing a pin can do is refuse, and these tests are about that refusal
 * reaching the caller as a non-zero return code.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
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

import { TARGET_STATE_VERSION_LATEST } from './safe/pinned-target-state'

const REPO_ROOT = join(import.meta.dir, '..', '..')

let workDir: string
let targetStatePath: string
let functionsPath: string

/**
 * Cuts one top-level function out of `helperFunctions.sh`.
 *
 * Sourcing the whole file is not an option — it reads `.env` and pulls in the
 * toolchain asserts — and copying the body into the test would prove only that the
 * copy agrees with itself.
 *
 * @param source - contents of helperFunctions.sh
 * @param name - function to extract
 * @returns the function's text, declaration through its closing brace
 */
const extractFunction = (source: string, name: string): string => {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `function ${name}() {`)
  if (start === -1) throw new Error(`${name} not found in helperFunctions.sh`)
  const end = lines.findIndex((line, index) => index > start && line === '}')
  if (end === -1) throw new Error(`${name} has no closing brace`)
  return lines.slice(start, end + 1).join('\n')
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'target-state-pin-'))
  mkdirSync(join(workDir, 'script', 'deploy'), { recursive: true })

  const helpers = readFileSync(
    join(REPO_ROOT, 'script', 'helperFunctions.sh'),
    'utf8'
  )
  functionsPath = join(workDir, 'functions.sh')
  writeFileSync(
    functionsPath,
    [
      extractFunction(helpers, 'findContractVersionInTargetState'),
      extractFunction(helpers, 'assertTargetStateVersionAllowed'),
    ].join('\n')
  )

  targetStatePath = join(workDir, 'script', 'deploy', '_targetState.json')
  writeFileSync(
    targetStatePath,
    JSON.stringify({
      mainnet: {
        production: {
          LiFiDiamond: {
            FollowsRepo: 'latest',
            PinnedToCurrent: '2.0.0',
            PinnedToOlder: '1.0.0',
            SuffixedBuild: '2.1.3',
          },
          LiFiDiamondImmutable: { OnlyOnImmutable: '1.0.0' },
        },
      },
    })
  )
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Runs `assertTargetStateVersionAllowed` against the fixture and returns its exit code.
 *
 * Only the two reads the guard makes are stubbed — the repo's current version and the
 * error sink; `findContractVersionInTargetState` is the real one, so the sentinel is
 * read exactly as the deploy scripts read it.
 *
 * @param contract - contract name to assert
 * @param currentVersion - the version the repo is at
 * @returns the guard's exit code, as `rc=<n>`
 */
const run = (
  contract: string,
  currentVersion: string,
  diamond = 'LiFiDiamond',
  statePath: string = targetStatePath
): string => {
  const harness = join(
    workDir,
    `harness-${contract}-${currentVersion}-${diamond}-${statePath.length}.sh`
  )
  writeFileSync(
    harness,
    `
    TARGET_STATE_PATH="${statePath}"
    TARGET_STATE_VERSION_LATEST="latest"
    error() { echo "[error] $*"; }
    getCurrentContractVersion() { echo "${currentVersion}"; }
    source "${functionsPath}"
    assertTargetStateVersionAllowed "${contract}" mainnet production ${diamond} >/dev/null
    echo "rc=$?"
  `
  )
  return execFileSync('bash', [harness], {
    cwd: workDir,
    encoding: 'utf8',
    env: { ...process.env, REPO_ROOT },
  }).trim()
}

// The sentinel is spelled once per language: `TARGET_STATE_VERSION_LATEST` in
// helperFunctions.sh and in pinned-target-state.ts. Nothing else ties the two together,
// and a drift is silent in the worst direction — bash would read `latest` as a version
// pin and refuse every deploy of every declared contract.
// The guard itself takes the diamond as an argument, so a unit test of it passes
// whatever the call site is wrong about. These assert the wiring instead: the original
// defect was deploySingleContract resolving the diamond from the CONTRACT's own name,
// which sends every facet and periphery contract to the LiFiDiamond block and silently
// skips a LiFiDiamondImmutable pin.
describe("the guard is wired to the caller's diamond", () => {
  it('deploySingleContract prefers the diamond it was passed', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'script', 'deploy', 'deploySingleContract.sh'),
      'utf8'
    )
    expect(source).toContain(
      // Bash parameter expansion, quoted from the script — not a JS template literal.
      // eslint-disable-next-line no-template-curly-in-string
      'assertTargetStateVersionAllowed "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "${TARGET_DIAMOND_NAME:-$DIAMOND_TYPE}"'
    )
    expect(source).toContain('local TARGET_DIAMOND_NAME="$6"')
  })

  it('deployPeripheryContracts passes its diamond through', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'script', 'deploy', 'deployPeripheryContracts.sh'),
      'utf8'
    )
    expect(source).toContain(
      'deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION" false "$DIAMOND_CONTRACT_NAME"'
    )
  })
})

describe('the latest sentinel', () => {
  it('is spelled the same in bash and in TypeScript', () => {
    const helpers = readFileSync(
      join(REPO_ROOT, 'script', 'helperFunctions.sh'),
      'utf8'
    )
    const declared = /^TARGET_STATE_VERSION_LATEST="([^"]+)"$/m.exec(
      helpers
    )?.[1]
    expect(declared).toBe(TARGET_STATE_VERSION_LATEST)
  })
})

describe('assertTargetStateVersionAllowed', () => {
  it('allows a network that follows the repo', () => {
    expect(run('FollowsRepo', '2.0.0')).toBe('rc=0')
  })

  it('allows a pin that matches the repo', () => {
    expect(run('PinnedToCurrent', '2.0.0')).toBe('rc=0')
  })

  it('blocks a pin the repo has moved past', () => {
    expect(run('PinnedToOlder', '2.0.0')).toBe('rc=1')
  })

  // A pin is equality, not a floor: the repo being older than the pin is just as
  // much "not the version this network asked for".
  it('blocks a pin the repo has not reached yet', () => {
    expect(run('PinnedToCurrent', '1.5.0')).toBe('rc=1')
  })

  // Membership is the callers' business: a contract with no entry is simply not
  // deployed here, which is not the guard's refusal to make.
  it('allows a contract the network does not declare', () => {
    expect(run('NotDeclared', '2.0.0')).toBe('rc=0')
  })

  // A pin is written bare, but @custom:version may carry a suffix (2.1.3-tron). Without
  // reducing to the base, such a build could never satisfy any pin.
  it('matches a pin against the base of a suffixed repo version', () => {
    expect(run('SuffixedBuild', '2.1.3-tron')).toBe('rc=0')
  })

  it('still blocks a suffixed build whose base differs from the pin', () => {
    expect(run('SuffixedBuild', '2.2.0-tron')).toBe('rc=1')
  })

  // The diamond the contract is being deployed FOR decides which block is read. Reading
  // the wrong one silently skips the pin, since a facet has no entry under the other
  // diamond and an absent entry is allowed.
  it('reads the pin from the diamond it was given', () => {
    expect(run('OnlyOnImmutable', '2.0.0', 'LiFiDiamondImmutable')).toBe('rc=1')
  })

  it("does not apply another diamond's pin", () => {
    expect(run('OnlyOnImmutable', '2.0.0', 'LiFiDiamond')).toBe('rc=0')
  })

  // findContractVersionInTargetState `exit 1`s on a missing file, which inside `$( )`
  // kills only the subshell — so without an explicit check the guard cannot tell
  // "unreadable" from "not declared" and waves the deploy through. A guard that cannot
  // read its input must refuse.
  it('blocks when the target state file is missing', () => {
    expect(
      run('FollowsRepo', '2.0.0', 'LiFiDiamond', join(workDir, 'gone.json'))
    ).toBe('rc=1')
  })

  it('blocks when TARGET_STATE_PATH is unset', () => {
    expect(run('FollowsRepo', '2.0.0', 'LiFiDiamond', '')).toBe('rc=1')
  })
})
