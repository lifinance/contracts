/**
 * Presence, not ancestry. These pin the two properties the distinction exists
 * for: a negative local read never decides, and only PRESENT ever proceeds.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  classifyGhAnswer,
  githubCommitPresence,
  resolveCommitPresence,
  type CommitPresenceQuery,
  type ICommitPresenceState,
} from './commit-presence'

const SHA = 'd92a6107d0636b47f75317dd4a7c672331975802'

const unpushed: ICommitPresenceState = {
  commit: SHA,
  repo: 'github.com/lifinance/contracts',
  localRemoteRefsContainingCommit: '',
  isShallow: false,
}

/** Records what the query was asked, so "never asked" is observable. */
const spy = (
  answer: ReturnType<CommitPresenceQuery>
): { query: CommitPresenceQuery; calls: [string, string][] } => {
  const calls: [string, string][] = []
  return {
    calls,
    query: (repo, commit) => {
      calls.push([repo, commit])
      return answer
    },
  }
}

const never: CommitPresenceQuery = () => {
  throw new Error('the query must not run')
}

describe('resolveCommitPresence', () => {
  it('answers PRESENT from a local remote-tracking ref without asking', () => {
    // The offline positive, and the reason this is not a new network dependency
    // on the happy path.
    const asked = spy({ presence: 'ABSENT', reason: 'should never be reached' })
    const result = resolveCommitPresence(
      { ...unpushed, localRemoteRefsContainingCommit: '  origin/main\n' },
      asked.query
    )

    expect(result.presence).toBe('PRESENT')
    expect(asked.calls).toEqual([])
  })

  it('asks the declared repository when no local ref contains the commit', () => {
    const asked = spy({
      presence: 'PRESENT',
      reason: 'the repository holds it',
    })
    const result = resolveCommitPresence(unpushed, asked.query)

    expect(result.presence).toBe('PRESENT')
    expect(asked.calls).toEqual([['github.com/lifinance/contracts', SHA]])
  })

  it('does not let a shallow clone decide the negative', () => {
    // The measured failure this replaces: `.git/shallow` holding one SHA made
    // local reachability reads answer nonsense, and the old check refused an
    // honest, pushed commit on that basis alone.
    const asked = spy({
      presence: 'PRESENT',
      reason: 'the repository holds it',
    })
    const result = resolveCommitPresence(
      { ...unpushed, isShallow: true },
      asked.query
    )

    expect(result.presence).toBe('PRESENT')
    expect(asked.calls).toHaveLength(1)
  })

  it('passes ABSENT through as the repository stated it', () => {
    const result = resolveCommitPresence(unpushed, () => ({
      presence: 'ABSENT',
      reason: 'no commit found',
    }))

    expect(result.presence).toBe('ABSENT')
    expect(result.reason).toContain('no commit found')
  })

  it('keeps UNKNOWN as UNKNOWN, never as an answer either way', () => {
    const result = resolveCommitPresence(unpushed, () => ({
      presence: 'UNKNOWN',
      reason: 'gh is not installed',
    }))

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('gh is not installed')
  })

  it('says so when a shallow clone cannot corroborate an UNKNOWN', () => {
    const result = resolveCommitPresence(
      { ...unpushed, isShallow: true },
      () => ({ presence: 'UNKNOWN', reason: 'gh is not installed' })
    )

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toMatch(/shallow clone/)
  })

  it.each([
    ['the sentinel a failed read returns', 'UNKNOWN'],
    ['an empty commit', ''],
    ['an abbreviated SHA', SHA.slice(0, 8)],
    ['a SHA with a path appended', `${SHA}/../other`],
  ])('does not ask any repository for %s', (_label, commit) => {
    // Nothing that is not a full SHA reaches a URL path.
    const result = resolveCommitPresence({ ...unpushed, commit }, never)

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('is not a commit SHA')
  })

  it('asks about the repository the record declares, not a fixed one', () => {
    const asked = spy({ presence: 'ABSENT', reason: 'no commit found' })
    resolveCommitPresence(
      { ...unpushed, repo: 'github.com/someone/fork' },
      asked.query
    )

    expect(asked.calls).toEqual([['github.com/someone/fork', SHA]])
  })
})

describe('classifyGhAnswer', () => {
  const REPO = 'github.com/lifinance/contracts'

  it('is PRESENT when the API echoes the SHA that was asked for', () => {
    // Real stdout of `gh api repos/lifinance/contracts/commits/<sha> --jq .sha`.
    expect(
      classifyGhAnswer(
        { status: 0, stdout: `${SHA}\n`, stderr: '', failedToRun: undefined },
        REPO,
        SHA
      ).presence
    ).toBe('PRESENT')
  })

  it('is UNKNOWN when a success answers about some other commit', () => {
    // A `--jq` change, a redirect, a truncated read: agreement was not observed,
    // so it is not reported.
    const result = classifyGhAnswer(
      { status: 0, stdout: 'b'.repeat(40), stderr: '', failedToRun: undefined },
      REPO,
      SHA
    )

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('answered with')
  })

  it('is ABSENT for the API answering that it holds no such commit', () => {
    // Real stderr, measured against lifinance/contracts on 2026-09-09: the
    // commit case is 422, not 404.
    const result = classifyGhAnswer(
      {
        status: 1,
        stdout: '',
        stderr: `gh: No commit found for SHA: ${SHA} (HTTP 422)`,
        failedToRun: undefined,
      },
      REPO,
      SHA
    )

    expect(result.presence).toBe('ABSENT')
  })

  it('is UNKNOWN for a 404, which is about the repository and not the commit', () => {
    // Measured: a repository that does not exist, and one the token cannot see,
    // are the same 404. Grading either ABSENT would report a forged commit.
    const result = classifyGhAnswer(
      {
        status: 1,
        stdout: '',
        stderr: 'gh: Not Found (HTTP 404)',
        failedToRun: undefined,
      },
      REPO,
      SHA
    )

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('HTTP 404')
  })

  it('is UNKNOWN when gh could not be started at all', () => {
    const result = classifyGhAnswer(
      {
        status: null,
        stdout: undefined,
        stderr: undefined,
        failedToRun: 'spawnSync gh ENOENT',
      },
      REPO,
      SHA
    )

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('ENOENT')
  })

  it('is UNKNOWN, naming the exit code, when gh failed silently', () => {
    const result = classifyGhAnswer(
      { status: 4, stdout: '', stderr: '', failedToRun: undefined },
      REPO,
      SHA
    )

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('gh exited 4')
  })
})

describe('githubCommitPresence', () => {
  it.each([
    ['a host with no known API shape', 'gitlab.com/lifinance/contracts'],
    ['the sentinel for an unidentifiable remote', 'UNKNOWN'],
    ['a subgroup path', 'github.com/lifinance/group/contracts'],
    ['an empty repository name', 'github.com/lifinance/'],
  ])('refuses to query %s, without spawning anything', (_label, repo) => {
    const result = githubCommitPresence(repo, SHA)

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('not a repository this check can query')
  })

  it('does not send a non-SHA to the API', () => {
    const result = githubCommitPresence(
      'github.com/lifinance/contracts',
      'UNKNOWN'
    )

    expect(result.presence).toBe('UNKNOWN')
    expect(result.reason).toContain('not a 40-character commit SHA')
  })
})
