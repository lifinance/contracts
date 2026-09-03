/**
 * CLI entry point for the recordability pre-flight, for a deploy script to run
 * from the repo root before anything broadcasts. Exits 0 when the deployment
 * about to happen could be verified afterwards, 1 with the reasons when not.
 */

import { execFileSync } from 'node:child_process'

import { consola } from 'consola'

import { assertTreeRecordable, type ITreeState } from './tree-recordable'

const git = <T>(args: string[], fallback: T): string | T => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
  } catch {
    return fallback
  }
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
  submoduleStatus: git(['submodule', 'status'], ''),
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
