/**
 * CI/deploy entry point for the recordability pre-flight.
 *
 * Run it from the repo root before anything broadcasts. Exits 0 when the
 * deployment about to happen could be verified afterwards, and 1 with the
 * reasons when it could not.
 *
 * It reads git and decides nothing itself — the rules live in
 * `tree-recordable.ts` so they can be tested without a repo in a given state.
 */

import { execFileSync } from 'child_process'

import { consola } from 'consola'

import { assertTreeRecordable, type ITreeState } from './tree-recordable'

/** `UNKNOWN` matches the sentinel `getCurrentGitCommitHash` records. */
const git = (args: string[], fallback: string): string => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
  } catch {
    return fallback
  }
}

const readTreeState = (): ITreeState => ({
  // `--no-renames` keeps every record to one path; `-z` keeps a path containing
  // a space in one piece.
  statusZ: git(['status', '--porcelain=v1', '-z', '--no-renames'], ''),
  head: git(['rev-parse', 'HEAD'], 'UNKNOWN').trim(),
  // Deliberately not preceded by a fetch: a guard on the deploy path should not
  // depend on the network, and a local `git push` updates this ref itself. The
  // refusal says what to do if the commit was pushed from another clone.
  remoteRefsContainingHead: git(['branch', '-r', '--contains', 'HEAD'], ''),
  isShallow:
    git(['rev-parse', '--is-shallow-repository'], 'true').trim() === 'true',
})

const main = (): void => {
  try {
    assertTreeRecordable(readTreeState())
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  consola.success(
    'Working tree matches a pushed commit — this deployment can be verified later.'
  )
}

main()
