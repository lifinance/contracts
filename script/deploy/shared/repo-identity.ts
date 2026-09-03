/**
 * Reduces a git remote URL to the repository identity a deployment record
 * stores. Import it wherever a record is written or a recorded repository is
 * compared; the shapes git accepts for one repository are not comparable as-is.
 */

import { spawnSync } from 'node:child_process'

/**
 * Sentinel for a remote that could not be identified.
 *
 * Distinct from an absent field, which on a stored record means the record
 * predates this capture rather than that the capture ran and failed. An audit
 * has to be able to tell those apart.
 */
export const REPO_UNKNOWN = 'UNKNOWN'

/** A hung git must never stall the command that records a deployment. */
const GIT_TIMEOUT_MS = 5_000

/**
 * Hosts that serve the same repositories under another name.
 *
 * GitHub and GitLab both publish an SSH endpoint for networks that block port
 * 22. Without this, one developer behind a corporate firewall records an
 * identity that compares unequal to everyone else's for the same repository.
 */
const HOST_ALIASES: Readonly<Record<string, string>> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com',
}

/** Runs git and returns stdout, or `undefined` if it did not run cleanly. */
export type GitRunner = (args: readonly string[]) => string | undefined

const defaultRunner: GitRunner = (args) => {
  const result = spawnSync('git', [...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return result.stdout
}

/**
 * Splits `[user@]host:path`, the form a plain `git clone git@host:owner/repo`
 * records.
 *
 * The userinfo is anchored to the last `@` before the first `/`, not the first
 * `@`: a password may contain one, and stopping early leaves its tail in the
 * host. A string carrying `://` is not this form and is rejected here rather
 * than matched on the scheme's own colon.
 *
 * @param remoteUrl - A trimmed remote URL.
 * @returns The host and path, or `undefined` when it is not this form.
 */
const parseScpLike = (
  remoteUrl: string
): { host: string; path: string } | undefined => {
  if (remoteUrl.includes('://')) return undefined

  const firstSlash = remoteUrl.indexOf('/')
  const authorityEnd = firstSlash === -1 ? remoteUrl.length : firstSlash
  const afterUserinfo = remoteUrl.slice(
    remoteUrl.lastIndexOf('@', authorityEnd - 1) + 1
  )

  const colon = afterUserinfo.indexOf(':')
  if (colon <= 0) return undefined

  const host = afterUserinfo.slice(0, colon)
  const path = afterUserinfo.slice(colon + 1)
  // A leading slash means a drive letter or an absolute path, not a repository.
  if (host.includes('/') || path === '' || path.startsWith('/'))
    return undefined

  return { host, path }
}

/**
 * The repository identity of a remote URL.
 *
 * Emits only a host and path that parsed, never the input: a remote URL can
 * carry a token in its userinfo, and a record is not the place to discover that
 * a URL did not parse the way it looked. Anything else is {@link REPO_UNKNOWN}.
 *
 * @param remoteUrl - Output of `git remote get-url`, or any remote URL.
 * @returns `host/owner/repo`, lower-cased and without a `.git` suffix, or
 * {@link REPO_UNKNOWN}.
 */
export const normalizeRepoUrl = (remoteUrl: string): string => {
  const trimmed = remoteUrl.trim()

  // URL parses the userinfo, port, query and fragment itself, and throws rather
  // than guessing when an unescaped credential makes the authority ambiguous.
  const parsed = trimmed.includes('://')
    ? (() => {
        try {
          const url = new URL(trimmed)
          return { host: url.hostname, path: url.pathname }
        } catch {
          return undefined
        }
      })()
    : parseScpLike(trimmed)

  if (parsed === undefined) return REPO_UNKNOWN

  const host = parsed.host.toLowerCase()
  const path = parsed.path
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
  if (host === '' || path === '') return REPO_UNKNOWN

  return `${HOST_ALIASES[host] ?? host}/${path}`
}

/**
 * The repository the local checkout was cloned from.
 *
 * @param runGit - Test seam for the subprocess. Production leaves this unset.
 * @returns `host/owner/repo`, or {@link REPO_UNKNOWN} when there is no `origin`
 * remote or its URL names no host and path.
 */
export const readRepoIdentity = (runGit: GitRunner = defaultRunner): string => {
  const remoteUrl = runGit(['remote', 'get-url', 'origin'])
  return remoteUrl === undefined ? REPO_UNKNOWN : normalizeRepoUrl(remoteUrl)
}
