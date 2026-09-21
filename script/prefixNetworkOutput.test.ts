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
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

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

/**
 * Every line that backgrounds a per-network worker, comments excluded.
 *
 * Matched on the launch itself rather than on the prefixer, so a worker piped through anything
 * else — `sed` in either quoting, `awk`, nothing at all — still appears here and fails the
 * assertion below. Pinning the `| prefixNetworkOutput ...` spelling instead would only catch
 * the one revert that happens to be spelled the way the old code was.
 */
const WORKER_LAUNCH = /^(?!\s*#).*\w+ToNetworkWorker\b.*&\s*$/gm

// the prefixer, passed some network variable - which one is the launcher's business
const THROUGH_PREFIXER = /\|\s*prefixNetworkOutput\s+"\$\w+"\s*&\s*$/

/**
 * List every `.sh` file under `dir`, recursively.
 *
 * Walked by hand rather than with `readdirSync`'s `recursive` option, which the pinned
 * `@types/node` (v17) does not know about. Symlinked directories are not followed.
 *
 * @param dir - absolute directory to walk
 * @returns absolute paths
 */
function shellScriptsUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...shellScriptsUnder(path))
    else if (entry.name.endsWith('.sh')) found.push(path)
  }
  return found
}

/**
 * Find every shell script that launches per-network workers.
 *
 * Discovered rather than listed: a third launcher added later is covered without anyone
 * remembering to extend a hardcoded array, which is the failure a list cannot see.
 *
 * @returns repo-relative paths, sorted
 */
function findLaunchers(): string[] {
  return shellScriptsUnder(join(REPO_ROOT, 'script'))
    .filter((path) => readFileSync(path, 'utf8').match(WORKER_LAUNCH))
    .map((path) => relative(REPO_ROOT, path))
    .sort()
}

describe('wave launchers', () => {
  const LAUNCHERS = findLaunchers()

  it('finds the launchers it is meant to guard', () => {
    // discovery returning nothing would make `it.each` below register no tests at all, and
    // pass. Named rather than counted, so a launcher added later is covered without an edit
    // here - which is the whole point of discovering them
    expect(LAUNCHERS).toContain('script/deploy/deployContractToNetworks.sh')
    expect(LAUNCHERS).toContain('script/tasks/proposeContractToNetworks.sh')
  })

  it.each(LAUNCHERS)(
    '%s tags every backgrounded worker through the prefixer',
    (file) => {
      const launches =
        readFileSync(join(REPO_ROOT, file), 'utf8').match(WORKER_LAUNCH) ?? []

      expect(launches.length).toBeGreaterThan(0)
      for (const launch of launches) expect(launch).toMatch(THROUGH_PREFIXER)
    }
  )
})
