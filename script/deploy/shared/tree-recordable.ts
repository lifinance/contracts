/**
 * Refuses a deploy whose record could not be verified later.
 *
 * A deployment record's whole value is the claim that rebuilding at its commit,
 * with its recorded profile, reproduces the deployed bytecode. Two things make
 * that claim false before anything is broadcast, and neither is visible
 * afterwards: the working tree did not match the commit, or the commit is not
 * anywhere a verifier can fetch it.
 *
 * This has to run at the deploy entry, before the broadcast. The obvious home —
 * beside `getCurrentGitCommitHash` in the deployment logger — is the wrong one:
 * the logger runs after the deploy in order to record it, so a refusal there
 * converts a bad record into a lost deployment.
 */

/**
 * Paths whose contents change the bytecode a rebuild produces.
 *
 * Deliberately an allowlist rather than F22's exclusion list. F22 specifies
 * `deployments/` and `broadcast/` as the exclusions for the provenance *flag* on
 * a proposal, where over-reporting is cosmetic. A refusal needs the narrower
 * trigger: taken as a deny-everything-else rule it also fires on the untracked
 * `typechain` symlink that every worktree created by `contracts-wt-add.sh`
 * carries, which would refuse every deploy from a worktree, and on any scratch
 * file in the checkout. Neither affects a rebuild.
 *
 * `script/` is deliberately absent. Dirty deploy scripting changes how a deploy
 * was performed, which is worth knowing, but not what a rebuild at this commit
 * produces — and that is the claim the record makes.
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
  /** `git status --porcelain=v1 -z --no-renames` output, verbatim. */
  statusZ: string
  /** `git rev-parse HEAD`, or the `UNKNOWN` sentinel. */
  head: string
  /** `git branch -r --contains HEAD` output; empty when no remote has it. */
  remoteRefsContainingHead: string
}

/**
 * Build-affecting paths that differ from the commit.
 *
 * @param statusZ - `git status --porcelain=v1 -z --no-renames` output. NUL
 * separated, so a path containing a space stays one entry; `--no-renames` keeps
 * every record to a single path.
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
 * Refuses unless the tree is recordable.
 *
 * Reports every problem it finds rather than the first, so an operator does not
 * learn about the second one on the next deploy attempt.
 *
 * @param state - The three git facts, read by the caller.
 * @throws When the tree has build-affecting changes, when the commit is on no
 * remote branch, or when the commit could not be determined.
 */
export const assertTreeRecordable = (state: ITreeState): void => {
  const problems: string[] = []

  if (state.head === UNKNOWN_COMMIT || state.head.trim() === '')
    problems.push(
      `The current commit could not be determined (got '${UNKNOWN_COMMIT}'). ` +
        `A record carrying that sentinel names no commit to rebuild at, so nothing ` +
        `could verify this deployment afterwards.`
    )

  const dirty = buildAffectingDirtyPaths(state.statusZ)
  if (dirty.length > 0)
    problems.push(
      `${dirty.length} build-affecting path(s) differ from the commit, so a rebuild ` +
        `at ${state.head} would not reproduce what is about to be deployed:\n` +
        dirty.map((path) => `    ${path}`).join('\n') +
        `\n  Commit or stash them first. Changes under deployments/, broadcast/ and ` +
        `script/ are ignored here — they do not affect the bytecode.`
    )

  if (state.remoteRefsContainingHead.trim() === '')
    problems.push(
      `Commit ${state.head} has not been pushed — no remote branch contains it. ` +
        `The record would point at a commit a verifier cannot fetch, so the rebuild ` +
        `it promises could never be performed. Push the branch first.`
    )

  if (problems.length > 0)
    throw new Error(
      `Refusing to deploy: this deployment could not be verified later.\n` +
        problems.map((problem) => `  - ${problem}`).join('\n')
    )
}
