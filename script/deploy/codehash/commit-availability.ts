/**
 * Makes a record's commit locally readable before anything is concluded from it.
 *
 * "Not in this checkout" is not evidence: the fleet sweep measured 56 of 98
 * audit commits unreachable from any local ref and retrievable by SHA. Deciding
 * unverifiable without trying the fetch grades honest deploys grey, and a grey
 * that is usually wrong is a grey signers learn to click through.
 *
 * The opposite failure is worse, so it is a separate outcome: a commit that
 * cannot be fetched ERRORs rather than falling through to "absent" (T3/D3).
 */

/** Bounded so one flaky moment is survivable and a dead remote cannot spin. */
export const MAX_FETCH_ATTEMPTS = 3

/**
 * A full 40-hex SHA and nothing shorter: git resolves a prefix against whatever
 * this checkout happens to hold, and a prefix handed to a fetch is an unbounded
 * request to the remote.
 */
const FULL_SHA = /^[0-9a-f]{40}$/

export type CommitAvailability =
  | { ok: true; fetched: boolean }
  | { ok: false; kind: 'refused' | 'error'; reason: string }

export interface ICommitAvailabilityDeps {
  /**
   * Runs git and returns stdout, throwing on a non-zero exit.
   * @param args - argv after `git`
   */
  git: (args: string[]) => string
}

/**
 * Ensures `sha` names a commit this checkout can read, fetching it if not.
 * @param sha - full 40-hex commit SHA from the deployment or audit record
 * @param deps - the git runner
 * @returns Whether the commit is now readable, and whether a fetch was needed
 */
export const ensureCommitAvailable = (
  sha: string,
  deps: ICommitAvailabilityDeps
): CommitAvailability => {
  if (!FULL_SHA.test(sha))
    return {
      ok: false,
      kind: 'refused',
      reason: `Commit lineage: "${sha}" is not a full 40-character commit SHA. A prefix is not accepted: git would resolve it against whatever this checkout happens to contain, and handing it to a fetch is an unbounded request to the remote.`,
    }

  if (hasCommit(sha, deps)) return { ok: true, fetched: false }

  let lastFailure = 'the remote did not report why'
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      deps.git(['fetch', '--quiet', 'origin', sha])
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
      continue
    }
    // A fetch that exits zero without producing the object leaves us exactly
    // where we started, so the check is repeated rather than assumed.
    if (hasCommit(sha, deps)) return { ok: true, fetched: true }
    lastFailure = 'the fetch succeeded but the commit is still not readable'
  }

  return {
    ok: false,
    kind: 'error',
    reason: `Commit lineage: ${sha} is not in this checkout and could not be fetched after ${MAX_FETCH_ATTEMPTS} attempts — ${lastFailure}. This is an ERROR, not "the commit does not exist": 56 of 98 audit commits are unreachable locally and retrievable by SHA, so nothing about the deployment can be concluded from a failed fetch.`,
  }
}

/**
 * @param sha - the commit to look for
 * @param deps - the git runner
 */
const hasCommit = (sha: string, deps: ICommitAvailabilityDeps): boolean => {
  try {
    // `^{commit}` so a tree or blob sharing the SHA cannot answer for a commit.
    deps.git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}
