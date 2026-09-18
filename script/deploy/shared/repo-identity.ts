/**
 * Reduces a git remote URL to the repository identity a deployment record
 * stores. Import it wherever a record is written or a recorded repository is
 * compared; the shapes git accepts for one repository are not comparable as-is.
 *
 * The gates that read a comparison point out of `origin` decide on the same
 * identity, through {@link isTrustedRemote} — one parser, so hardening it
 * hardens every caller at once.
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
 * The only shape allowed out of this module.
 *
 * Applied to the finished identity rather than to the input, because two
 * attempts at enumerating malformed remote URLs both shipped a parse that let a
 * credential through. Whatever a parser is talked into producing, an `@`, a
 * colon, a space or an empty path segment cannot reach a record.
 */
const IDENTITY =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(\/[a-z0-9._-]+)+$/

/** Schemes git fetches over. Anything else is not a remote we can rebuild from. */
const ALLOWED_SCHEMES = new Set([
  'http',
  'https',
  'ssh',
  'git',
  'git+ssh',
  'ftp',
  'ftps',
])

/**
 * Hosts that serve the same repositories under another name.
 *
 * GitHub and GitLab both publish an SSH endpoint for networks that block port
 * 22. Without this, one developer behind a corporate firewall records an
 * identity that compares unequal to everyone else's for the same repository.
 *
 * A Map, not an object: a plain object answers for `constructor` and
 * `__proto__` too, and `?? host` does not fire for an inherited member.
 */
const HOST_ALIASES = new Map([
  ['ssh.github.com', 'github.com'],
  ['altssh.gitlab.com', 'gitlab.com'],
])

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
 * @param remoteUrl - A trimmed remote URL with no scheme.
 * @returns The host and path, or `undefined` when it is not this form. Both are
 * checked by {@link IDENTITY} afterwards, which is what actually holds: a
 * credential containing `/` puts its `@` beyond the first slash, where no
 * anchor here can find it.
 */
const parseScpLike = (
  remoteUrl: string
): { host: string; path: string } | undefined => {
  const firstSlash = remoteUrl.indexOf('/')
  const authorityEnd = firstSlash === -1 ? remoteUrl.length : firstSlash
  const afterUserinfo = remoteUrl.slice(
    remoteUrl.lastIndexOf('@', authorityEnd - 1) + 1
  )

  const colon = afterUserinfo.indexOf(':')
  if (colon <= 0) return undefined

  const path = afterUserinfo.slice(colon + 1)
  // A leading slash makes this a drive letter or an absolute path, not the
  // owner/repo an scp-style remote names.
  if (path.startsWith('/')) return undefined

  return { host: afterUserinfo.slice(0, colon), path }
}

/**
 * Splits a URL that carries a scheme.
 *
 * @param remoteUrl - A trimmed remote URL containing `://`.
 * @returns The host and path, or `undefined` for a scheme git does not fetch
 * over or an authority `URL` could not read.
 */
const parseWithScheme = (
  remoteUrl: string
): { host: string; path: string } | undefined => {
  try {
    const url = new URL(remoteUrl)
    if (!ALLOWED_SCHEMES.has(url.protocol.replace(/:$/, '').toLowerCase()))
      return undefined
    return { host: url.hostname, path: url.pathname }
  } catch {
    return undefined
  }
}

/**
 * The repository identity of a remote URL.
 *
 * @param remoteUrl - Output of `git remote get-url`, or any remote URL.
 * @returns `host/owner/repo`, lower-cased and without a `.git` suffix, or
 * {@link REPO_UNKNOWN} for anything that does not reduce to exactly that.
 */
export const normalizeRepoUrl = (remoteUrl: string): string => {
  const trimmed = remoteUrl.trim()
  // `URL` decodes percent-escapes and then resolves `..` away, so this has to
  // see what it will see: `%2e%2e` reaches it as `..` and would otherwise map a
  // remote at another path onto this one. An identity this module accepts never
  // needs an escape, so decoding first costs nothing.
  const decoded = ((): string => {
    try {
      return decodeURIComponent(trimmed)
    } catch {
      return trimmed
    }
  })()
  if (/(^|[/:])\.\.?(\/|$)/.test(decoded)) return REPO_UNKNOWN

  const parsed = trimmed.includes('://')
    ? parseWithScheme(trimmed)
    : parseScpLike(trimmed)
  if (parsed === undefined) return REPO_UNKNOWN

  // A trailing dot is the same host; left alone it splits the identity in two.
  const host = parsed.host.toLowerCase().replace(/\.$/, '')
  // Both spellings git clones from have to land on the same identity, and each
  // strip can expose what the other was meant to remove: `…/contracts.git/`
  // hides the suffix behind a slash, `…/contracts/.git` leaves one behind.
  const path = parsed.path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()

  const identity = `${HOST_ALIASES.get(host) ?? host}/${path}`
  return IDENTITY.test(identity) ? identity : REPO_UNKNOWN
}

/**
 * The repository the local checkout was cloned from.
 *
 * @param runGit - Test seam for the subprocess. Production leaves this unset.
 * @returns `host/owner/repo`, or {@link REPO_UNKNOWN} when there is no `origin`
 * remote or its URL names no repository.
 */
export const readRepoIdentity = (runGit: GitRunner = defaultRunner): string => {
  const remoteUrl = runGit(['remote', 'get-url', 'origin'])
  return remoteUrl === undefined ? REPO_UNKNOWN : normalizeRepoUrl(remoteUrl)
}

/**
 * Repository identities the signing and deploy gates compare a remote against.
 *
 * Tron cut proposals are run from the fork rather than from this repo (see
 * `docs/TronFork.md`), so the deploy gate has to admit it; the target-state
 * anchor does not, and passes only {@link REPO_CONTRACTS}.
 */
export const REPO_CONTRACTS = 'github.com/lifinance/contracts'
export const REPO_CONTRACTS_TRON = 'github.com/lifinance/contracts-tron'

/**
 * Schemes a gate may read a remote over.
 *
 * Narrower than {@link ALLOWED_SCHEMES}, which says what git can fetch over:
 * a cleartext remote carries no evidence that what came back is what the
 * repository holds, and the commit a gate compares against arrives over it.
 */
const AUTHENTICATED_SCHEMES = new Set(['https', 'ssh'])

/**
 * Whether a remote names a repository a gate may take its comparison point from.
 *
 * `origin` is whatever the clone happens to point at, so a ref alone does not
 * establish where its content came from: against a fork remote a proposer can
 * author the very state the gate grades them against.
 *
 * What this settles is the URL, not the transport. A gate runs on the
 * proposer's own machine, where `GIT_SSH_COMMAND` or a `git` earlier on `PATH`
 * reaches a different repository while `git remote get-url` still reports this
 * one — so read a `true` as "the clone is not pointed somewhere else", never as
 * proof of what the fetch returned.
 * @param remoteUrl - output of `git remote get-url origin`
 * @param allowedRepos - identities as {@link normalizeRepoUrl} returns them
 * @returns `true` only for an authenticated scheme naming one of those repositories
 */
export const isTrustedRemote = (
  remoteUrl: string,
  allowedRepos: readonly string[]
): boolean => {
  const trimmed = remoteUrl.trim()
  const schemeEnd = trimmed.indexOf('://')
  // No scheme is the scp-style form, which git fetches over ssh.
  if (
    schemeEnd !== -1 &&
    !AUTHENTICATED_SCHEMES.has(trimmed.slice(0, schemeEnd).toLowerCase())
  )
    return false

  const identity = normalizeRepoUrl(trimmed)
  return identity !== REPO_UNKNOWN && allowedRepos.includes(identity)
}
