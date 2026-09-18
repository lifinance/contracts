/**
 * Regression tests for `prefixNetworkOutput` (`script/helperFunctions.sh`), the per-network
 * output tagger used by the deploy and propose wave launchers.
 *
 * It replaced `| sed "s/^/[$NETWORK] /"`, which block-buffers when its stdout is not a tty: the
 * whole of a worker's output then landed at once when that worker exited, so a run wedged eight
 * minutes ago and a run still working looked identical in a redirected log (EXSC-1038). The
 * streaming test below is the one that pins that fix — a revert to `sed` passes every other
 * assertion here.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Run `script` with `prefixNetworkOutput` pulled out of `helperFunctions.sh`.
 *
 * The function is extracted rather than sourced: `helperFunctions.sh` runs `set -a` and expects
 * a populated `.env`, neither of which this behaviour depends on.
 *
 * @param script - bash to run once the definition is loaded
 */
function withPrefixer(script: string): string {
  // -E, not BRE: BSD sed has no `\\?`, so a basic-regex extraction silently matches nothing
  // and every test then fails with "command not found".
  const extract = `source <(sed -nE '/^(function )?prefixNetworkOutput\\(\\) \\{/,/^\\}/p' script/helperFunctions.sh)`
  return execFileSync('bash', ['-c', `${extract}\n${script}`, 'harness'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
}

describe('prefixNetworkOutput', () => {
  it('writes each line as it arrives, before the producer exits', () => {
    // the producer holds the pipe open for 2s after its first line; a block-buffering
    // consumer writes nothing until it closes, so an empty file here is the bug
    const output = withPrefixer(`
      TMPFILE=$(mktemp)
      { echo "first"; sleep 2; echo "second"; } | prefixNetworkOutput "arbitrum" >"$TMPFILE" &
      sleep 0.5
      echo "AFTER_HALF_SECOND:$(cat "$TMPFILE")"
      wait
      echo "FINAL:$(tr '\\n' '|' <"$TMPFILE")"
      rm -f "$TMPFILE"
    `)

    expect(output).toContain('AFTER_HALF_SECOND:[arbitrum] first')
    expect(output).toContain('FINAL:[arbitrum] first|[arbitrum] second|')
  })

  it('prefixes every line with the network name', () => {
    const output = withPrefixer(
      `printf 'one\\ntwo\\nthree\\n' | prefixNetworkOutput "base"`
    )

    expect(output).toBe('[base] one\n[base] two\n[base] three\n')
  })

  it('emits a trailing line that has no newline', () => {
    // a worker killed mid-line leaves one: dropping it would hide the last thing it said
    const output = withPrefixer(
      `printf 'complete\\npartial' | prefixNetworkOutput "optimism"`
    )

    expect(output).toBe('[optimism] complete\n[optimism] partial\n')
  })

  it('passes line content through untouched', () => {
    const output = withPrefixer(
      `printf '    indented\\nback\\\\slash\\n100%% done\\n' | prefixNetworkOutput "polygon"`
    )

    expect(output).toBe(
      '[polygon]     indented\n[polygon] back\\slash\n[polygon] 100% done\n'
    )
  })

  it('writes nothing for empty input', () => {
    const output = withPrefixer(
      `printf '' | prefixNetworkOutput "mainnet"; echo "rc=$?"`
    )

    expect(output).toBe('rc=0\n')
  })
})

describe('wave launchers', () => {
  const LAUNCHERS = [
    'script/deploy/deployContractToNetworks.sh',
    'script/tasks/proposeContractToNetworks.sh',
  ]

  it.each(LAUNCHERS)('%s tags worker output through the prefixer', (file) => {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')

    expect(source).toContain('| prefixNetworkOutput "$WAVE_NETWORK" &')
    // the buffering this replaced is invisible in a passing deploy, so guard the revert
    expect(source).not.toMatch(/\|\s*sed\s+"s\/\^\//)
  })
})
