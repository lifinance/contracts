/**
 * Regression tests for the stall report in `launchDeployWave`
 * (`script/deploy/deployContractToNetworks.sh`).
 *
 * A wave is backgrounded pipelines, so its `wait` cannot return until each output reader sees
 * EOF, which needs every holder of that pipe's write end to close it. A child that outlives its
 * worker therefore keeps the whole wave open after the on-chain work is done and no forge or
 * cast is left running — the EXSC-1038 shape. That child is orphaned the instant its worker
 * exits, so the report has to list the process group rather than walk children; a `pgrep -P`
 * walk finds nothing and prints an empty report, which is the failure this pins.
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
  ['script/deploy/deployContractToNetworks.sh', 'reportStalledWave'],
  ['script/helperFunctions.sh', 'prefixNetworkOutput'],
]
  .map(
    // -E, not BRE: BSD sed has no `\\?`, so a basic-regex extraction silently matches nothing
    ([file, fn]) => `sed -nE '/^(function )?${fn}\\(\\) \\{/,/^\\}/p' ${file}`
  )
  .join('\n')

/**
 * Run a wave whose worker finishes its "deploy" and then leaves a child alive, so the wave is
 * held open with nothing left to do.
 *
 * @param leftoverSeconds - how long that child outlives its worker
 */
function runStalledWave(leftoverSeconds: number): string {
  const script = `
    eval "$(${DEFS})"
    warning() { printf '[warning] %s\\n' "$1"; }
    deployToNetworkWorker() {
      echo "deploying $3 to $1..."
      ( exec -a LEFTOVER_CHILD sleep ${leftoverSeconds} ) &
      echo "OK" >"$5/$1"
    }
    RESULT_DIR=$(mktemp -d)
    WAVE_STALL_REPORT_SECONDS=5 launchDeployWave 10 production SomeFacet 1.0.0 "$RESULT_DIR" sepolia
    echo "RESULT:$(cat "$RESULT_DIR/sepolia")"
    rm -rf "$RESULT_DIR"
  `
  return execFileSync('bash', ['-c', script, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

describe('launchDeployWave stall report', () => {
  it('names the leftover child holding the wave open, and still completes', () => {
    const output = runStalledWave(12)

    expect(output).toContain('wave still running 5s after its last output')
    // the orphan a pgrep -P walk cannot reach: PPID 1, still in the run's process group
    expect(output).toMatch(/LEFTOVER_CHILD/)
    expect(output).toContain('RESULT:OK')
  }, 60_000)

  it('stays quiet for a wave that finishes inside the threshold', () => {
    // finishes during the first poll sleep: the threshold is reached, the wave is not stalled
    const output = runStalledWave(1)

    expect(output).not.toContain('wave still running')
    expect(output).toContain('RESULT:OK')
  }, 60_000)
})
