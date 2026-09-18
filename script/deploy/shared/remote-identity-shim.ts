/**
 * Test support for the deploy gate's remote check.
 *
 * The gate refuses to compare against a main read through an untrusted
 * `origin`, so a fixture repository wired to a local bare repo cannot reach the
 * gate's own logic at all. Tests that drive the gate in-process pass
 * `readRemoteUrl`; this is the same seam for the ones that spawn a real CLI,
 * where no argument crosses the process boundary.
 *
 * Only `git remote get-url origin` is answered. Fetch and `ls-remote` still
 * resolve through the fixture's real configured URL, so those tests stay
 * offline and a remote the test breaks on purpose still fails the way it did
 * before. A test that wants to assert on the repository identity a child
 * *records* cannot use this, because that read goes through the same command.
 *
 * Nothing under a CLI entry point imports this.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory the shim is written to, relative to the fixture repository root. */
export const SHIM_BIN_DIR = '.gate-test-bin'

const SHIMMED_REMOTE = 'git@github.com:lifinance/contracts.git'

/**
 * Writes a `git` that reports the canonical remote and passes everything else through.
 * @param repoRoot - fixture repository root
 * @returns the directory to prepend to the child's `PATH`
 */
export const installRemoteIdentityShim = (repoRoot: string): string => {
  const binDir = join(repoRoot, SHIM_BIN_DIR)
  mkdirSync(binDir, { recursive: true })

  // Resolved now and written in absolutely, so the shim cannot re-enter itself
  // through the PATH it is about to be placed on.
  const realGit = spawnSync('which', ['git'], {
    encoding: 'utf8',
  }).stdout.trim()
  const shim = join(binDir, 'git')
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$#" = 3 ] && [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "${SHIMMED_REMOTE}"
  exit 0
fi
exec ${realGit} "$@"
`
  )
  chmodSync(shim, 0o755)

  return binDir
}
