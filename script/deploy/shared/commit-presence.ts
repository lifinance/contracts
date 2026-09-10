/**
 * Answers whether a commit is present in the repository a deployment record
 * names. Import it wherever that commit has to be shown fetchable — before a
 * deploy, or when verifying a record afterwards.
 *
 * Presence, not ancestry. `origin/main` is squash-merged, so a commit that was
 * genuinely built and deployed is usually reachable from nothing at all once its
 * PR lands, and asking whether it is an ancestor of a branch answers a question
 * about the local checkout rather than about the repository.
 */

import { spawnSync } from 'node:child_process'

/** A hung network call must never stall a deploy pre-flight. */
const QUERY_TIMEOUT_MS = 10_000

const SHA = /^[0-9a-f]{40}$/i

/** The only host whose API shape this module knows. */
const QUERYABLE_HOSTS = new Set(['github.com'])

/**
 * Verdicts, in terms of what each permits.
 *
 * Only `PRESENT` may proceed. `ABSENT` is the repository answering that it
 * holds no such commit; `UNKNOWN` is this module failing to get an answer, and
 * the two are kept apart for the operator's sake alone — a caller that treats
 * `UNKNOWN` as anything but a refusal has made not asking into a pass.
 */
export type CommitPresence = 'PRESENT' | 'ABSENT' | 'UNKNOWN'

export interface ICommitPresence {
  presence: CommitPresence
  /** One line naming what was asked and what answered. */
  reason: string
}

/**
 * Asks a repository whether it holds a commit. The seam tests inject; production
 * passes {@link githubCommitPresence}.
 */
export type CommitPresenceQuery = (
  repo: string,
  commit: string
) => ICommitPresence

export interface ICommitPresenceState {
  /** The commit a record would name, or a sentinel when it could not be read. */
  commit: string
  /** Declared repository identity, `host/owner/repo`, as a record stores it. */
  repo: string
  /**
   * `git branch -r --contains <commit> --list 'origin/*'` output.
   *
   * Read as a positive only. A remote-tracking ref containing the commit means
   * this clone fetched it from that remote, which settles presence offline; the
   * empty case settles nothing, because a shallow clone, a deleted branch and an
   * unfetched one all produce it.
   */
  localRemoteRefsContainingCommit: string
  /** `git rev-parse --is-shallow-repository`. Diagnostic wording only. */
  isShallow: boolean
}

const parseGithubRepo = (
  repo: string
): { host: string; owner: string; name: string } | undefined => {
  const [host, owner, name, ...rest] = repo.split('/')
  if (
    host === undefined ||
    owner === undefined ||
    name === undefined ||
    rest.length > 0
  )
    return undefined
  if (!QUERYABLE_HOSTS.has(host) || owner === '' || name === '')
    return undefined
  return { host, owner, name }
}

/**
 * Asks GitHub whether a repository holds a commit.
 *
 * Read-only and via `gh`, so it inherits the deployer's existing credentials and
 * touches no local object store — a check on the deploy path must not rewrite
 * refs to answer a question.
 *
 * @param repo - Declared repository identity, `host/owner/repo`.
 * @param commit - 40-hex commit SHA.
 * @returns `ABSENT` only for the API's own "no commit found" answer. A missing
 * or unauthenticated `gh`, a repository this token cannot see (which answers
 * `404` indistinguishably from one that does not exist) and any transport
 * failure are all `UNKNOWN`.
 */
export const githubCommitPresence: CommitPresenceQuery = (repo, commit) => {
  const parsed = parseGithubRepo(repo)
  if (parsed === undefined)
    return {
      presence: 'UNKNOWN',
      reason: `'${repo}' is not a repository this check can query (it knows ${[
        ...QUERYABLE_HOSTS,
      ].join(', ')})`,
    }

  if (!SHA.test(commit))
    return {
      presence: 'UNKNOWN',
      reason: `'${commit}' is not a 40-character commit SHA, so it was not sent to ${repo}`,
    }

  const result = spawnSync(
    'gh',
    [
      'api',
      `repos/${parsed.owner}/${parsed.name}/commits/${commit}`,
      // `GH_HOST` applies only where no hostname was given, so passing one pins
      // the question to the host the record declares — otherwise an exported
      // `GH_HOST` would answer about another server's repository of the same
      // name.
      '--hostname',
      parsed.host,
      '--jq',
      '.sha',
    ],
    {
      encoding: 'utf8',
      timeout: QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  return classifyGhAnswer(
    {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      failedToRun: result.error?.message,
    },
    repo,
    commit
  )
}

/** What `gh api` reported, as much of it as the classification needs. */
export interface IGhAnswer {
  status: number | null
  stdout: string | undefined
  stderr: string | undefined
  /** Set when the process could not be started or timed out. */
  failedToRun: string | undefined
}

/**
 * Turns one `gh api` result into a verdict.
 *
 * Separate from the call so the classification is testable against the strings
 * the API actually returns rather than against a mocked network.
 *
 * @param answer - What `gh api …/commits/<sha>` reported.
 * @param repo - Declared repository identity, for the message.
 * @param commit - The commit that was asked about.
 * @returns `ABSENT` only for the API's own "no commit found" (HTTP 422).
 * `404` is not one: it covers both a repository that does not exist and one
 * this token cannot see, neither of which is an answer about the commit.
 */
export const classifyGhAnswer = (
  answer: IGhAnswer,
  repo: string,
  commit: string
): ICommitPresence => {
  if (answer.failedToRun !== undefined)
    return {
      presence: 'UNKNOWN',
      reason: `could not ask ${repo} whether it holds ${commit}: ${answer.failedToRun}`,
    }

  const stdout = (answer.stdout ?? '').trim()
  const stderr = (answer.stderr ?? '').trim()

  if (answer.status === 0)
    return stdout.toLowerCase() === commit.toLowerCase()
      ? { presence: 'PRESENT', reason: `${repo} holds ${commit}` }
      : {
          presence: 'UNKNOWN',
          reason: `${repo} was asked for ${commit} and answered with '${stdout}'`,
        }

  if (/HTTP 422/.test(stderr) || /No commit found for SHA/i.test(stderr))
    return { presence: 'ABSENT', reason: `${repo} holds no commit ${commit}` }

  return {
    presence: 'UNKNOWN',
    reason: `${repo} did not answer whether it holds ${commit}: ${
      stderr === '' ? `gh exited ${String(answer.status)}` : stderr
    }`,
  }
}

/**
 * Resolves whether a record's commit is present in the repository it names.
 *
 * The local refs are consulted first because they are free and offline, and
 * because that ordering is what keeps this from being a new network dependency
 * on the happy path: a deploy from a fetched clone of a pushed branch never
 * reaches the query. Only the case a purely local check already refuses does.
 *
 * @param state - The commit, the declared repository, and the local git facts.
 * @param query - How to ask the repository; production passes
 * {@link githubCommitPresence}.
 * @returns The verdict and one line explaining it. Never throws: the caller owns
 * the verdict, because the same facts hard-block a production deploy and only
 * warn on staging.
 */
export const resolveCommitPresence = (
  state: ICommitPresenceState,
  query: CommitPresenceQuery
): ICommitPresence => {
  if (!SHA.test(state.commit))
    return {
      presence: 'UNKNOWN',
      reason: `'${state.commit}' is not a commit SHA, so no repository could be asked for it`,
    }

  if (state.localRemoteRefsContainingCommit.trim() !== '')
    return {
      presence: 'PRESENT',
      reason: `${state.commit} is on a remote-tracking ref in this clone, so the remote it was fetched from holds it`,
    }

  const answer = query(state.repo, state.commit)
  if (answer.presence === 'PRESENT' || answer.presence === 'ABSENT')
    return answer

  return {
    presence: 'UNKNOWN',
    reason: state.isShallow
      ? `${answer.reason}. This is a shallow clone, so the local refs cannot rule it out either`
      : answer.reason,
  }
}
