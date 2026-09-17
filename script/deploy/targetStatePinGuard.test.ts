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
          },
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
const run = (contract: string, currentVersion: string): string => {
  const harness = join(workDir, `harness-${contract}-${currentVersion}.sh`)
  writeFileSync(
    harness,
    `
    TARGET_STATE_PATH="${targetStatePath}"
    TARGET_STATE_VERSION_LATEST="latest"
    error() { echo "[error] $*"; }
    getCurrentContractVersion() { echo "${currentVersion}"; }
    source "${functionsPath}"
    assertTargetStateVersionAllowed "${contract}" mainnet production LiFiDiamond >/dev/null
    echo "rc=$?"
  `
  )
  return execFileSync('bash', [harness], {
    cwd: workDir,
    encoding: 'utf8',
    env: { ...process.env, REPO_ROOT },
  }).trim()
}

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
})
