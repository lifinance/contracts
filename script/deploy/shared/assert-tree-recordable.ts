/**
 * CLI entry point for the recordability pre-flight, for a deploy script to run
 * from the repo root before anything broadcasts. Exits 0 when the deployment
 * about to happen could be verified afterwards, 1 with the reasons when not.
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

import { consola } from 'consola'

import {
  assertTreeRecordable,
  submodulePathsInIndex,
  type ITreeState,
} from './tree-recordable'

const git = <T>(args: string[], fallback: T): string | T => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
  } catch {
    return fallback
  }
}

/**
 * Whether a path is the root of a checked-out git repository.
 *
 * Counting directory entries is not enough: `--ignore-submodules=untracked`
 * makes porcelain silent about untracked-only submodule content, so a single
 * ignored file — a `.DS_Store`, an empty scratch directory — inside an
 * otherwise empty submodule would satisfy both checks at once. `git -C` alone
 * is not enough either: on a plain directory it walks up and answers for the
 * superproject.
 *
 * @param path - Absolute path to a submodule's working tree.
 * @returns True when git resolves that path as its own repository root.
 */
const isCheckedOutRepository = (path: string): boolean => {
  const top = git(['-C', path, 'rev-parse', '--show-toplevel'], undefined)
  if (top === undefined) return false

  try {
    // realpath because a temp directory reaches git as /private/tmp and the
    // caller as /tmp. This catch is defensive only — it needs the path to stop
    // existing between the two calls above, so no test reaches it.
    return realpathSync(top.trim()) === realpathSync(path)
  } catch {
    return false
  }
}

/**
 * Submodule paths whose source a rebuild would not find.
 *
 * Presence on disk rather than registration. `git submodule status` marks a
 * submodule uninitialized whenever its URL is absent from .git/config, which is
 * true of every fully populated submodule in the primary deploy clone — a
 * rebuild there resolves their source fine.
 *
 * @returns The absent paths, or `undefined` when the index could not be read.
 */
const readAbsentSubmodulePaths = (): string[] | undefined => {
  // `--full-name -- :/` reports the whole repository from any working
  // directory; `git ls-files` is otherwise scoped to the cwd subtree, unlike
  // every other read here.
  const staged = git(
    ['ls-files', '--stage', '-z', '--full-name', '--', ':/'],
    undefined
  )
  const root = git(['rev-parse', '--show-toplevel'], undefined)
  if (staged === undefined || root === undefined) return undefined

  return submodulePathsInIndex(staged).filter(
    (path) => !isCheckedOutRepository(join(root.trim(), path))
  )
}

const readTreeState = (): ITreeState => ({
  // `--untracked-files=all` overrides a local status.showUntrackedFiles=no,
  // which would otherwise hide a new source file. `--ignore-submodules=untracked`
  // drops the one state porcelain cannot distinguish from a real change: a
  // submodule holding only untracked content (a .DS_Store, a stray forge cache)
  // reports the same ` M lib/x` as one left at a different commit, and no
  // remedy the refusal could name would clear it.
  statusZ: git(
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
      '--ignore-submodules=untracked',
    ],
    undefined
  ),
  head: git(['rev-parse', 'HEAD'], 'UNKNOWN').trim(),
  // Deliberately not preceded by a fetch: a guard on the deploy path should not
  // depend on the network, and a local `git push` updates this ref itself.
  remoteRefsContainingHead: git(
    ['branch', '-r', '--contains', 'HEAD', '--list', 'origin/*'],
    ''
  ),
  absentSubmodulePaths: readAbsentSubmodulePaths(),
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
