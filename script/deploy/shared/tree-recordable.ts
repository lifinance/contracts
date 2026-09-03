/**
 * Decides whether a deploy about to happen could be verified afterwards.
 *
 * A deployment record's whole value is the claim that rebuilding at its commit
 * reproduces the deployed bytecode. Import this from a deploy entry point,
 * before anything broadcasts.
 */

/**
 * Paths whose contents change the bytecode a rebuild produces.
 *
 * An allowlist, because a deny-everything-else rule also fires on the untracked
 * `typechain` symlink every worktree carries and on any scratch file in the
 * checkout, neither of which affects a rebuild. `script/` is absent for the
 * same reason: dirty deploy scripting changes how a deploy was performed, not
 * what a rebuild at this commit produces, and the record stores the constructor
 * arguments and salt a script chose explicitly.
 */
const BUILD_AFFECTING_PREFIXES = ['src/', 'lib/'] as const
const BUILD_AFFECTING_FILES = [
  'foundry.toml',
  'remappings.txt',
  'foundry.lock',
] as const

/** The sentinel `getCurrentGitCommitHash` returns instead of throwing. */
const UNKNOWN_COMMIT = 'UNKNOWN'

export interface ITreeState {
  /**
   * `git status --porcelain=v1 -z --no-renames --untracked-files=all
   * --ignore-submodules=untracked` output, or `undefined` when it could not be
   * read at all. Distinguished from `''` because an unreadable status is the
   * one input that must never be mistaken for a clean tree.
   */
  statusZ: string | undefined
  /** `git rev-parse HEAD`, or the `UNKNOWN` sentinel. */
  head: string
  /**
   * `git branch -r --contains HEAD --list 'origin/*'` output. Restricted to
   * `origin` because a commit pushed only to a fork, or to the `tron` remote,
   * is not fetchable from the repository the record names.
   */
  remoteRefsContainingHead: string
  /**
   * Submodule paths recorded in the index whose working tree holds no files, or
   * `undefined` when the index could not be read. Presence on disk rather than
   * `git submodule status`, which reports `-` whenever a submodule's URL is
   * absent from .git/config — true of a fully populated `lib/ds-test` in the
   * primary deploy clone, whose source a rebuild resolves fine.
   */
  absentSubmodulePaths: string[] | undefined
  /**
   * `git rev-parse --is-shallow-repository`. A shallow clone's commit graph is
   * truncated, so it can confirm that a remote branch contains HEAD but cannot
   * be trusted when it reports that none does.
   */
  isShallow: boolean
}

/**
 * Build-affecting paths that differ from the commit.
 *
 * @param statusZ - Porcelain v1 output, NUL separated. `-z` is load-bearing:
 * without it git quotes and escapes paths containing spaces or non-ASCII, and
 * `--no-renames` keeps every record to a single path — a rename otherwise emits
 * the destination first and the source as a bare second entry.
 * @returns The offending paths, in the order git reported them.
 */
export const buildAffectingDirtyPaths = (statusZ: string): string[] =>
  statusZ
    .split('\0')
    .filter((entry) => entry.length > 3)
    // Porcelain v1 is two status characters, a space, then the path.
    .map((entry) => entry.slice(3))
    .filter(
      (path) =>
        BUILD_AFFECTING_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
        BUILD_AFFECTING_FILES.includes(
          path as (typeof BUILD_AFFECTING_FILES)[number]
        )
    )

/**
 * Submodule paths recorded in the index.
 *
 * @param lsFilesStageZ - `git ls-files --stage -z` output. Mode 160000 is a
 * gitlink; `-z` keeps a path containing a space in one piece.
 * @returns Every submodule path, in index order.
 */
export const submodulePathsInIndex = (lsFilesStageZ: string): string[] =>
  lsFilesStageZ
    .split('\0')
    .filter((entry) => entry.startsWith('160000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
    .filter((path) => path !== '')

/**
 * Refuses unless the tree is recordable.
 *
 * States the problem without a verdict: the same facts hard-block a production
 * deploy and only warn on staging, so the caller supplies the word. Reports
 * every problem it finds rather than the first, so an operator does not learn
 * about the second one on the next deploy attempt.
 *
 * @param state - The git facts, read by the caller.
 * @throws When any of them says a rebuild at `state.head` would not reproduce
 * what is about to be deployed, or that no verifier could fetch that commit.
 */
export const assertTreeRecordable = (state: ITreeState): void => {
  const problems: string[] = []

  if (state.head === UNKNOWN_COMMIT || state.head.trim() === '')
    problems.push(
      `The current commit could not be determined (got '${UNKNOWN_COMMIT}'). ` +
        `A record carrying that sentinel names no commit to rebuild at, so nothing ` +
        `could verify this deployment afterwards.`
    )

  if (state.statusZ === undefined)
    problems.push(
      `The working tree could not be read ('git status' failed), so whether it ` +
        `matches ${state.head} is unknown. Treated as a refusal rather than as a ` +
        `clean tree, because reading nothing and finding nothing are not the same.`
    )
  else {
    const dirty = buildAffectingDirtyPaths(state.statusZ)
    if (dirty.length > 0)
      problems.push(
        `${dirty.length} build-affecting path(s) differ from the commit, so a rebuild ` +
          `at ${state.head} would not reproduce what is about to be deployed:\n` +
          dirty.map((path) => `    ${path}`).join('\n') +
          `\n  Commit or stash them first. A path under lib/ is a submodule left at a ` +
          `different commit — 'git submodule update --init <path>' restores it, and ` +
          `'git stash' will not. Changes under deployments/, broadcast/ and script/ ` +
          `are ignored here; so is untracked content inside a submodule.`
      )
  }

  if (state.absentSubmodulePaths === undefined)
    problems.push(
      `The index could not be read ('git ls-files' failed), so whether every ` +
        `submodule is checked out is unknown. Treated as a refusal rather than as ` +
        `a complete tree.`
    )
  else if (state.absentSubmodulePaths.length > 0)
    problems.push(
      `${state.absentSubmodulePaths.length} submodule(s) are not checked out, so the source ` +
        `a rebuild would compile is not present:\n` +
        state.absentSubmodulePaths.map((path) => `    ${path}`).join('\n') +
        `\n  Run 'git submodule update --init --recursive'.`
    )

  if (state.remoteRefsContainingHead.trim() === '') {
    if (state.isShallow)
      problems.push(
        `This is a shallow clone, so 'git branch -r --contains' reporting no remote ` +
          `branch for ${state.head} cannot be trusted — the commit graph is truncated. ` +
          `Deploy from a full clone, or fetch with depth 0.`
      )
    else
      problems.push(
        `Commit ${state.head} is on no origin branch. The record would point at a ` +
          `commit a verifier cannot fetch from this repository, so the rebuild it ` +
          `promises could never be performed. Push the branch first, or run ` +
          `'git fetch origin' if it was pushed from another clone — this check ` +
          `never fetches, and a commit carried only by a tag does not count.`
      )
  }

  if (problems.length > 0)
    throw new Error(
      `This deployment could not be verified later.\n` +
        problems.map((problem) => `  - ${problem}`).join('\n')
    )
}
