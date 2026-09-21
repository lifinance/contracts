/**
 * Regression tests for the stall report in `launchDeployWave`
 * (`script/deploy/deployContractToNetworks.sh`).
 *
 * A wave is backgrounded pipelines, so its `wait` cannot return until each output reader sees
 * EOF, which needs every holder of that pipe's write end to close it. A child that outlives its
 * worker therefore keeps the whole wave open after the on-chain work is done and no forge or
 * cast is left running — the EXSC-1038 shape. That child is orphaned the instant its worker
 * exits, so the report has to reach beyond this script's own children; a `pgrep -P` walk finds
 * nothing and prints an empty report, which is the failure this pins.
 *
 * The wave stalls in two places and both are covered here: the drain that follows the launches,
 * and the throttle between them, where a wave narrower than it is long spends its launch phase
 * (every zkEVM network after the first) and where a stall used to go unreported entirely.
 */
import { execFileSync } from 'child_process'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')

const DEFS = [
  ['script/deploy/deployContractToNetworks.sh', 'launchDeployWave'],
  ['script/deploy/deployContractToNetworks.sh', 'waitForWaveCapacity'],
  ['script/deploy/deployContractToNetworks.sh', 'resolveStallReportThreshold'],
  ['script/deploy/deployContractToNetworks.sh', 'reportStalledWave'],
  ['script/helperFunctions.sh', 'prefixNetworkOutput'],
]
  .map(
    // -E, not BRE: BSD sed has no `\\?`, so a basic-regex extraction silently matches nothing
    ([file, fn]) => `sed -nE '/^(function )?${fn}\\(\\) \\{/,/^\\}/p' ${file}`
  )
  .join('\n')

/**
 * The child a worker leaves behind. A copy of `sleep` under its own name, rather than `exec -a
 * LEFTOVER_CHILD sleep`: the report prints `comm`, which on Linux is the executable's basename
 * and ignores an argv[0] rewrite, so the rewritten name is visible on macOS only and the
 * assertion below would pass locally while failing on CI.
 */
const LEFTOVER_CHILD = 'leftoverchild'

const LEFTOVER_SETUP = `
    LEFTOVER_DIR=$(mktemp -d)
    cp "$(command -v sleep)" "$LEFTOVER_DIR/${LEFTOVER_CHILD}"
`

/**
 * Run a wave whose worker finishes its "deploy" and then leaves a child alive, so the wave is
 * held open with nothing left to do.
 *
 * @param leftoverSeconds - how long that child outlives its worker
 */
function runStalledWave(leftoverSeconds: number): string {
  const script = `
    source <(
${DEFS}
    )
    warning() { printf '[warning] %s\\n' "$1"; }
    error() { printf '[error] %s\\n' "$1"; }
${LEFTOVER_SETUP}
    deployToNetworkWorker() {
      echo "deploying $3 to $1..."
      "$LEFTOVER_DIR/${LEFTOVER_CHILD}" ${leftoverSeconds} &
      echo "OK" >"$5/$1"
    }
    RESULT_DIR=$(mktemp -d)
    WAVE_STALL_REPORT_SECONDS=5 launchDeployWave 10 production SomeFacet 1.0.0 "$RESULT_DIR" sepolia
    echo "RESULT:$(cat "$RESULT_DIR/sepolia")"
    rm -rf "$RESULT_DIR" "$LEFTOVER_DIR"
  `
  return execFileSync('bash', ['-c', script, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

/**
 * Run a sequential wave whose first worker leaves a child alive, so the wave stalls while its
 * remaining networks are still queued behind the throttle, unlaunched.
 *
 * @param leftoverSeconds - how long that child outlives the first worker
 */
function runStalledLaunchWave(leftoverSeconds: number): string {
  const script = `
    source <(
${DEFS}
    )
    warning() { printf '[warning] %s\\n' "$1"; }
    error() { printf '[error] %s\\n' "$1"; }
${LEFTOVER_SETUP}
    deployToNetworkWorker() {
      echo "deploying $3 to $1..."
      if [[ "$1" == "net1" ]]; then
        "$LEFTOVER_DIR/${LEFTOVER_CHILD}" ${leftoverSeconds} &
      fi
      echo "OK" >"$5/$1"
    }
    RESULT_DIR=$(mktemp -d)
    WAVE_STALL_REPORT_SECONDS=5 launchDeployWave 1 production SomeFacet 1.0.0 "$RESULT_DIR" net1 net2
    echo "RESULTS:$(find "$RESULT_DIR" -type f | wc -l | tr -d ' ')"
    rm -rf "$RESULT_DIR" "$LEFTOVER_DIR"
  `
  return execFileSync('bash', ['-c', script, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

/**
 * Launch a wave with the given stall threshold, in a subshell so a refusal's `exit` leaves the
 * harness alive to report it.
 *
 * @param setting - the value `WAVE_STALL_REPORT_SECONDS` is set to
 */
function runWaveWithThreshold(setting: string): string {
  const script = `
    source <(
${DEFS}
    )
    warning() { printf '[warning] %s\\n' "$1"; }
    error() { printf '[error] %s\\n' "$1"; }
    deployToNetworkWorker() { echo "OK" >"$5/$1"; }
    RESULT_DIR=$(mktemp -d)
    ( WAVE_STALL_REPORT_SECONDS='${setting}' launchDeployWave 10 production SomeFacet 1.0.0 "$RESULT_DIR" sepolia )
    echo "EXIT:$?"
    rm -rf "$RESULT_DIR"
  `
  return execFileSync('bash', ['-c', script, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

describe('launchDeployWave stall threshold', () => {
  // resolved before the first worker launches: bash arithmetic reads each of these as 0, which
  // would fire the report on every poll of the whole wave rather than never
  it.each(['0', '-1', 'abc', '1abc'])(
    'refuses to start a wave with WAVE_STALL_REPORT_SECONDS=%p',
    (setting) => {
      const output = runWaveWithThreshold(setting)

      expect(output).toContain(
        'WAVE_STALL_REPORT_SECONDS must be a positive integer'
      )
      expect(output).toContain('EXIT:1')
    },
    60_000
  )

  it('accepts a positive integer', () => {
    const output = runWaveWithThreshold('30')

    expect(output).not.toContain('must be a positive integer')
    expect(output).toContain('EXIT:0')
  }, 60_000)

  it('falls back to the default when the value is blank', () => {
    // `.env` ships blank entries, and `${VAR:-600}` treats blank as unset, matching how
    // MAX_CONCURRENT_JOBS is resolved in this same file
    const output = runWaveWithThreshold('')

    expect(output).not.toContain('must be a positive integer')
    expect(output).toContain('EXIT:0')
  }, 60_000)
})

describe('launchDeployWave stall report', () => {
  it('names the leftover child holding the wave open, and still completes', () => {
    const output = runStalledWave(12)

    expect(output).toContain('wave has been running 5s')
    // the orphan a pgrep -P walk cannot reach: reparented to PPID 1, but still in the
    // run's process group, which is why the report reaches past this script's own subtree.
    // macOS prints the path it was invoked with where Linux prints the basename
    expect(output).toMatch(
      new RegExp(
        `^\\s+\\d+\\s+\\d+\\s+1\\s+\\S+\\s+\\S+\\s+\\S*${LEFTOVER_CHILD}$`,
        'm'
      )
    )
    expect(output).toContain('RESULT:OK')
  }, 60_000)

  it('reports a stall that strands the wave before its last network launches', () => {
    // the zkEVM shape: concurrency 1, so net2 cannot launch until net1's pipeline closes, and
    // the wave is stuck in the throttle rather than in the drain that follows the launches
    const output = runStalledLaunchWave(12)

    const firstReport = output.indexOf('wave has been running')
    const secondLaunch = output.indexOf('[net2] deploying')
    expect(firstReport).toBeGreaterThanOrEqual(0)
    expect(secondLaunch).toBeGreaterThanOrEqual(0)
    // the point of the test: reported while still launching, not once the loop was done
    expect(firstReport).toBeLessThan(secondLaunch)
    expect(output).toContain('RESULTS:2')
  }, 60_000)

  it('stays quiet for a wave that finishes inside the threshold', () => {
    // finishes during the first poll sleep: the threshold is reached, the wave is not stalled
    const output = runStalledWave(1)

    expect(output).not.toContain('wave has been running')
    expect(output).toContain('RESULT:OK')
  }, 60_000)

  it('prints executables without their arguments', () => {
    // a live `cast send` carries --private-key and an --rpc-url with the provider key in
    // argv, so the report must never widen back to `command=` ([CONV:REDACT-RPC-URL])
    const output = runStalledWave(12)

    const listed = output
      .split('\n')
      .filter((line) => /^\s+\d+\s+\d+\s+\d+\s/.test(line))
    expect(listed.length).toBeGreaterThan(0)
    for (const line of listed) {
      const executable = line.trim().split(/\s+/).slice(5).join(' ')
      expect(executable).not.toMatch(/\s/)
    }
  }, 60_000)
})
