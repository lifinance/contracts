/**
 * Regression tests for the concurrency throttle in `launchDeployWave`
 * (`script/deploy/deployContractToNetworks.sh`).
 *
 * The throttle counted `$(jobs | wc -l)`. `jobs` inside `$(...)` runs in a subshell, so it
 * prints a copy of the table and exits without the parent ever reaping: once no job is running
 * the count pins at 1 rather than falling to 0. At a concurrency of 1 the condition is then
 * permanently true and the loop spins forever — EXSC-1038's `MAX_CONCURRENT_JOBS=1` repro, and
 * the deadlock the first test covers. Measured against the pre-fix throttle, a wave of three
 * networks times out with one of three results written.
 *
 * Above 1 the old count was accurate while jobs were in flight (the stale entry only appears
 * once none is running), so the second test passes either way. It is a guard on the limit being
 * honoured, not a regression test. `jobs -rp` lists running jobs only, which is accurate from a
 * subshell.
 *
 * Concurrency is proved by counting workers that are actually running at the same time, not by
 * wall-clock elapsed: a loaded host makes a correct wave slow, so an elapsed upper bound would
 * fail on a healthy throttle. Each worker drops a marker file and samples how many exist, so the
 * peak of those samples can never exceed true simultaneity — `peak <= limit` cannot flake.
 * Reaching the limit is what would race, since nothing makes a wave saturate, so each worker
 * first holds at a barrier until the marker count reaches the limit. That turns `peak == limit`
 * into a deterministic assertion rather than a slow-host coin flip, and keeps the test honest
 * about a throttle that permits too little rather than too much. The elapsed assertions are
 * lower bounds only, which slowness cannot break.
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
 * Run a wave of one-second workers, each of which records how many workers were running
 * alongside it.
 *
 * @param concurrency - networks allowed to run at once
 * @param networks - how many networks make up the wave
 * @returns seconds elapsed, results written, and the peak simultaneous worker count
 */
function runWave(
  concurrency: number,
  networks: number
): { elapsed: number; results: number; peak: number } {
  const names = Array.from({ length: networks }, (_, i) => `net${i}`).join(' ')
  const script = `
    source <(
${DEFS}
    )
    warning() { printf '[warning] %s\\n' "$1"; }
    error() { printf '[error] %s\\n' "$1"; }
    RUN_DIR=$(mktemp -d)
    RESULT_DIR=$(mktemp -d)
    running() { find "$RUN_DIR" -name 'running.*' | wc -l | tr -d ' '; }
    deployToNetworkWorker() {
      MARKER=$(mktemp "$RUN_DIR/running.XXXXXX")
      # barrier: hold until the wave is saturated, so the sample below observes real
      # overlap rather than racing the next worker's launch. Bounded, so a throttle
      # that never saturates fails on the sample with a readable peak instead of
      # hanging until the harness timeout.
      SPINS=0
      while [[ $(running) -lt ${concurrency} && $SPINS -lt 100 ]]; do
        sleep 0.1
        SPINS=$((SPINS + 1))
      done
      running >>"$RUN_DIR/samples"
      sleep 1
      rm -f "$MARKER"
      echo "OK" >"$5/$1"
    }
    START=$SECONDS
    launchDeployWave ${concurrency} production SomeFacet 1.0.0 "$RESULT_DIR" ${names}
    echo "ELAPSED:$((SECONDS - START))"
    echo "RESULTS:$(find "$RESULT_DIR" -type f | wc -l | tr -d ' ')"
    echo "PEAK:$(sort -n "$RUN_DIR/samples" | tail -1)"
    rm -rf "$RESULT_DIR" "$RUN_DIR"
  `
  const output = execFileSync('bash', ['-c', script, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    elapsed: Number(/ELAPSED:(\d+)/.exec(output)?.[1]),
    results: Number(/RESULTS:(\d+)/.exec(output)?.[1]),
    peak: Number(/PEAK:(\d+)/.exec(output)?.[1]),
  }
}

describe('launchDeployWave throttle', () => {
  it('runs a wave at a concurrency of 1 instead of deadlocking', () => {
    const { elapsed, results, peak } = runWave(1, 3)

    expect(results).toBe(3)
    expect(peak).toBe(1)
    // one at a time: three 1s workers cannot finish in under 3s
    expect(elapsed).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('holds the wave to the configured concurrency', () => {
    const { elapsed, results, peak } = runWave(2, 4)

    expect(results).toBe(4)
    expect(peak).toBe(2)
    // two at a time: four 1s workers cannot finish in under 2s
    expect(elapsed).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
