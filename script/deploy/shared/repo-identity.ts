/**
 * Reduces a git remote URL to the repository identity a deployment record
 * stores. Import it wherever a record is written or a recorded repository is
 * compared; the shapes git accepts for the same repository are not otherwise
 * comparable.
 */

/**
 * Sentinel for a remote that could not be identified.
 *
 * Distinct from the empty string, which on a stored record means the field
 * predates this capture rather than that the capture ran and failed — the same
 * split `getCurrentGitCommitHash` already uses for the commit hash.
 */
export const REPO_UNKNOWN = 'UNKNOWN'

/** `scp`-style, the default for a GitHub SSH clone: `git@host:owner/repo.git`. */
const SCP_LIKE = /^(?:[^@/]+@)?(?<host>[^:/]+):(?<path>[^:].*)$/
/** Any URL git accepts with an explicit scheme, including `ssh://` and `file://`. */
const WITH_SCHEME =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(?<host>[^:/]+)(?::\d+)?\/(?<path>.+)$/i

/**
 * The repository identity of a remote URL.
 *
 * Emits only a `host/path` pair extracted from a recognised shape, never the
 * input itself: a remote URL can carry a token in its userinfo, and echoing an
 * unparsed string into a record would put that token in the database.
 *
 * @param remoteUrl - Output of `git remote get-url`, or any remote URL.
 * @returns `host/owner/repo`, lower-cased and without a `.git` suffix, or
 * {@link REPO_UNKNOWN} when no host and path could be read.
 */
export const normalizeRepoUrl = (remoteUrl: string): string => {
  const trimmed = remoteUrl.trim()
  const match = WITH_SCHEME.exec(trimmed) ?? SCP_LIKE.exec(trimmed)
  const host = match?.groups?.['host']
  const path = match?.groups?.['path']
  if (host === undefined || path === undefined) return REPO_UNKNOWN

  const cleanedPath = path
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
  if (cleanedPath === '') return REPO_UNKNOWN

  return `${host.toLowerCase()}/${cleanedPath}`
}
