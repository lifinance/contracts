/**
 * Regression tests for the concurrency throttle in `launchDeployWave`
 * (`script/deploy/deployContractToNetworks.sh`).
 *
 * The throttle counted `$(jobs | wc -l)`. `jobs` inside `$(...)` runs in a subshell, so it
 * prints a copy of the table and exits without the parent ever reaping: once no job is running
 * the count pins at 1 rather than falling to 0. At a concurrency of 1 the condition is then
 * permanently true and the loop spins forever — EXSC-1038's `MAX_CONCURRENT_JOBS=1` repro, and
 * the deadlock the first test covers. Measured against the pre-fix throttle, a wave of three
 * networks is aborted with one of three results written.
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
 *
 * A wedged wave is ended by a watchdog inside the harness rather than by the outer
 * `execFileSync` timeout. Left to the timeout, a deadlock costs a CI runner 60s of dead
 * wall-clock, reports `ETIMEDOUT` rather than the deadlock, and leaks the worker subshell that
 * outlives the SIGTERM sent to the harness. The watchdog instead kills each worker's process
 * tree with the script's own `killProcessTree` and reports the results and peak the wave
 * reached, so the failure arrives in seconds and the assertion that fires names the deadlock.
 *
 * The wave stays in the harness shell itself. Running it as `{ launchDeployWave ...; } &` would
 * be the shorter way to bound it, but the fork changes what the code under test does: measured,
 * `$(jobs | wc -l)` inside a forked subshell reaps normally under `bash -c`, so the pre-fix
 * throttle completes a concurrency-1 wave there and the regression goes undetected. Hence a
 * watchdog that signals the shell, and `disown` so the throttle does not count the watchdog
 * itself as a wave slot.
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

// a correct wave here runs 3s at the longest, so this only fires on a wedged throttle
const ABORT_AFTER_SECONDS = 15
const ABORT_AFTER_POLLS = ABORT_AFTER_SECONDS * 10

const DEFS = [
  ['script/deploy/deployContractToNetworks.sh', 'launchDeployWave'],
  ['script/deploy/deployContractToNetworks.sh', 'killProcessTree'],
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
 * @returns whether the watchdog had to abort the wave, plus seconds elapsed, results written,
 *   and the peak simultaneous worker count the wave reached
 */
function runWave(
  concurrency: number,
  networks: number
): { aborted: boolean; elapsed: number; results: number; peak: number } {
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
      # running out the watchdog.
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
    report() {
      PEAK=$(sort -n "$RUN_DIR/samples" 2>/dev/null | tail -1)
      echo "ABORTED:$1"
      echo "ELAPSED:$((SECONDS - START))"
      echo "RESULTS:$(find "$RESULT_DIR" -type f | wc -l | tr -d ' ')"
      echo "PEAK:\${PEAK:-0}"
      rm -rf "$RESULT_DIR" "$RUN_DIR"
    }
    abortWave() {
      trap - SIGTERM
      for CHILD_PID in $(pgrep -P $$ 2>/dev/null); do
        killProcessTree "$CHILD_PID"
      done
      report 1
      exit 0
    }
    trap abortWave SIGTERM
    START=$SECONDS
    HARNESS_PID=$$
    # disowned so the throttle under test does not count the watchdog as a wave slot, and
    # detached from stdout so it cannot hold the harness pipe open after a healthy wave
    {
      POLLS=0
      while [[ ! -f "$RUN_DIR/done" && $POLLS -lt ${ABORT_AFTER_POLLS} ]]; do
        sleep 0.1
        POLLS=$((POLLS + 1))
      done
      [[ -f "$RUN_DIR/done" ]] || kill -TERM "$HARNESS_PID" 2>/dev/null
    } >/dev/null 2>&1 &
    disown
    launchDeployWave ${concurrency} production SomeFacet 1.0.0 "$RESULT_DIR" ${names}
    touch "$RUN_DIR/done"
    report 0
  `
  const output = execFileSync('bash', ['-c', script, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // backstop only - the watchdog ends a wedged wave well before this
    timeout: 60_000,
  })
  return {
    aborted: /ABORTED:1/.test(output),
    elapsed: Number(/ELAPSED:(\d+)/.exec(output)?.[1]),
    results: Number(/RESULTS:(\d+)/.exec(output)?.[1]),
    peak: Number(/PEAK:(\d+)/.exec(output)?.[1]),
  }
}

describe('launchDeployWave throttle', () => {
  it('runs a wave at a concurrency of 1 instead of deadlocking', () => {
    const { aborted, elapsed, results, peak } = runWave(1, 3)

    // asserted together so a wedge prints as `aborted: true, results: 1` - the deadlock
    // itself - rather than as a bare boolean that says nothing about how far the wave got
    expect({ aborted, results, peak }).toEqual({
      aborted: false,
      results: 3,
      peak: 1,
    })
    // one at a time: three 1s workers cannot finish in under 3s
    expect(elapsed).toBeGreaterThanOrEqual(3)
  }, 60_000)

  it('holds the wave to the configured concurrency', () => {
    const { aborted, elapsed, results, peak } = runWave(2, 4)

    expect({ aborted, results, peak }).toEqual({
      aborted: false,
      results: 4,
      peak: 2,
    })
    // two at a time: four 1s workers cannot finish in under 2s
    expect(elapsed).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
