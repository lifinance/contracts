/**
 * Covers the repository identity a deployment record stores: what a remote URL
 * reduces to, what never leaves the parser, and how the two provenance fields
 * are split across an upsert.
 */

import { spawnSync } from 'node:child_process'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'


import { getCurrentRepo, provenanceUpdate } from './mongo-log-utils'
import {
  REPO_UNKNOWN,
  normalizeRepoUrl,
  readRepoIdentity,
  type GitRunner,
} from './repo-identity'

/**
 * The guarantee a record depends on, written as properties rather than as the
 * production regex, so a loosened regex does not loosen its own test.
 *
 * @param identity - Anything `normalizeRepoUrl` returned.
 * @returns Whether it is safe to store.
 */
const isStorableIdentity = (identity: string): boolean => {
  if (identity === REPO_UNKNOWN) return true

  const segments = identity.split('/')
  return (
    segments.length >= 2 &&
    segments.every((segment) => segment !== '') &&
    ![...identity].some((character) => !/[a-z0-9._-]|\//.test(character))
  )
}

describe('REPO_UNKNOWN', () => {
  it('is the uppercase sentinel the deployment log already standardised on', () => {
    // Asserted as a literal on purpose: every other test compares against the
    // imported constant, so changing its value would otherwise pass them all
    // while collapsing the "ran and failed" and "predates the field" states.
    expect(REPO_UNKNOWN).toBe('UNKNOWN')
  })
})

describe('normalizeRepoUrl', () => {
  it.each([
    ['scp-style ssh', 'git@github.com:lifinance/contracts.git'],
    ['https with suffix', 'https://github.com/lifinance/contracts.git'],
    ['https without suffix', 'https://github.com/lifinance/contracts'],
    ['ssh:// url', 'ssh://git@github.com/lifinance/contracts.git'],
    ['trailing slash', 'https://github.com/lifinance/contracts/'],
    ['trailing newline', 'git@github.com:lifinance/contracts.git\n'],
    ['non-standard port', 'ssh://git@github.com:22/lifinance/contracts.git'],
    ['git protocol', 'git://github.com/lifinance/contracts.git'],
    ['a query string', 'https://github.com/lifinance/contracts.git?ref=x'],
    ['a fragment', 'https://github.com/lifinance/contracts.git#frag'],
    ['scp-style with no user', 'github.com:lifinance/contracts.git'],
    ['a trailing dot on the host', 'https://github.com./lifinance/contracts'],
    [
      'userinfo with a token',
      'https://x-access-token:ghp_T@github.com/lifinance/contracts.git',
    ],
  ])('reduces %s to one identity', (_label, url) => {
    expect(normalizeRepoUrl(url)).toBe('github.com/lifinance/contracts')
  })

  it.each([
    [
      'ssh://git@ssh.github.com:443/lifinance/contracts.git',
      'github.com/lifinance/contracts',
    ],
    [
      'ssh://git@altssh.gitlab.com:443/lifinance/contracts.git',
      'gitlab.com/lifinance/contracts',
    ],
  ])('folds %s onto exactly one canonical host', (url, expected) => {
    // Asserted per row against the exact host. A shared regex accepting either
    // github or gitlab cannot tell an alias pointing at the wrong host from a
    // correct one, which is the distinction this field exists to make.
    expect(normalizeRepoUrl(url)).toBe(expected)
  })

  it.each([
    ['constructor', 'https://constructor/a/b', 'constructor/a/b'],
    ['toString', 'https://tostring/a/b', 'tostring/a/b'],
  ])(
    'treats a host named %s as a host, not a prototype member',
    (_l, url, expected) => {
      // The alias table is a Map for this: on an object literal these resolve to
      // inherited members, and `?? host` does not fire for them, so the host
      // became a function's source text. The output check would refuse that, but
      // the correct answer is the host itself.
      expect(normalizeRepoUrl(url)).toBe(expected)
    }
  )
  it('lower-cases, because the host and GitHub owner names are case-insensitive', () => {
    expect(normalizeRepoUrl('git@GitHub.com:LiFinance/Contracts.git')).toBe(
      'github.com/lifinance/contracts'
    )
  })

  it.each([
    [
      'a fork',
      'git@github.com:someuser/contracts.git',
      'github.com/someuser/contracts',
    ],
    [
      'another host',
      'git@gitlab.com:group/sub/proj.git',
      'gitlab.com/group/sub/proj',
    ],
    [
      'the tron remote',
      'https://github.com/lifinance/contracts-tron.git',
      'github.com/lifinance/contracts-tron',
    ],
  ])('keeps %s distinct', (_label, url, expected) => {
    expect(normalizeRepoUrl(url)).toBe(expected)
  })

  /**
   * Shapes that reached the output of one of the two earlier revisions of this
   * parser. Each carries something a record must never hold, or maps a remote
   * onto an identity that is not its own.
   */
  const MUST_NOT_PASS = [
    [
      'slash in an https password',
      'https://user:pa/ss@github.com/lifinance/contracts',
    ],
    [
      'slash in an scp password',
      'user:pa/ss@github.com:lifinance/contracts.git',
    ],
    [
      'slash in an internal scp password',
      'deploy:s3cr3t/token@git.internal:team/repo.git',
    ],
    [
      'base64 token with a slash',
      'https://lifi:zK3n/AbC+dEf9@dev.azure.com/lifi/contracts/_git/contracts',
    ],
    [
      'aws codecommit style',
      'https://danb:ab9/xq+token3d@git-codecommit.eu-central-1.amazonaws.com/v1/repos/contracts',
    ],
    ['an at sign left in the path', 'git@github.com:lifinance/con@tracts.git'],
    ['a prototype key as the host', '__proto__:a/b'],
    [
      'path traversal onto our identity',
      'https://github.com/attacker/../lifinance/contracts',
    ],
    [
      'percent-encoded path traversal',
      'https://github.com/attacker/%2e%2e/lifinance/contracts',
    ],
    [
      'upper-case percent-encoded traversal',
      'https://github.com/attacker/%2E%2E/lifinance/contracts',
    ],
    ['a single-dot segment', 'https://github.com/lifinance/./contracts'],
    ['a javascript scheme', 'javascript://alert(1)@evil.com/a/b'],
    [
      'a data scheme carrying a payload',
      'data://text/plain;base64,SECRETPAYLOAD@x/y',
    ],
    ['an ipv6 host', 'ssh://git@[::1]:22/a/b'],
    ['an empty path segment', 'https://github.com//lifinance//contracts'],
    ['a space in the path', 'https://github.com/lifi nance/contracts'],
    ['a local path', '/Users/someone/Documents/GitHub/contracts'],
    ['a relative path', '../contracts.git'],
    ['a bare word', 'origin'],
    ['a file url', 'file:///Users/dev/contracts'],
    ['a windows path', 'C:/Users/dev/contracts'],
    ['a windows path with an at', 'C:Users/dev@host:a/b'],
    ['a host with no path', 'https://github.com/'],
    ['empty', ''],
    ['whitespace only', '   \n'],
  ] as const

  it.each(MUST_NOT_PASS)('refuses %s', (_label, url) => {
    expect(normalizeRepoUrl(url)).toBe(REPO_UNKNOWN)
  })

  it('emits a storable identity or the sentinel, for every shape tried here', () => {
    // The invariant, over every input this file names rather than over a list
    // of token substrings: a credential this test has never seen still cannot
    // reach a record, because nothing outside the identity alphabet can.
    const everyUrl = [
      ...MUST_NOT_PASS.map(([, url]) => url),
      'git@github.com:lifinance/contracts.git',
      'https://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI@github.com/a/b',
      'https://x:eyJhbGciOiJIUzI1NiJ9.payload.sig@github.com/a/b',
      'https://constructor/a/b',
      'toString:a/b',
      'git+ssh://git@github.com/lifinance/contracts.git',
      'HTTPS://GitHub.com/LiFinance/Contracts.git',
      '://',
      'ssh://git@github.com:22/lifinance/contracts.git',
    ]

    for (const url of everyUrl) {
      const identity = normalizeRepoUrl(url)

      expect({ url, storable: isStorableIdentity(identity) }).toEqual({
        url,
        storable: true,
      })
    }
  })
})

describe('readRepoIdentity', () => {
  const runnerReturning =
    (value: string | undefined): GitRunner =>
    () =>
      value

  it('asks git for the origin remote and normalizes what it gets', () => {
    const asked: string[][] = []
    const identity = readRepoIdentity((args) => {
      asked.push([...args])
      return 'git@github.com:lifinance/contracts.git\n'
    })

    expect(asked).toEqual([['remote', 'get-url', 'origin']])
    expect(identity).toBe('github.com/lifinance/contracts')
  })

  it('reports the sentinel when git did not run cleanly', () => {
    expect(readRepoIdentity(runnerReturning(undefined))).toBe(REPO_UNKNOWN)
  })

  it('reports the sentinel when the remote names no repository', () => {
    expect(readRepoIdentity(runnerReturning('/some/local/path\n'))).toBe(
      REPO_UNKNOWN
    )
  })

  it('drives the production runner against real git', () => {
    // The one case that exercises the real subprocess rather than the injected
    // seam. Deterministic in a checkout with no origin and in a mirror whose
    // remote is not ours: the contract asserted is the shape of the answer, not
    // which repository this happens to be.
    const hasOrigin =
      spawnSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf8',
      }).status === 0
    const identity = getCurrentRepo()

    expect(isStorableIdentity(identity)).toBe(true)
    if (hasOrigin) expect(identity).not.toBe(REPO_UNKNOWN)
    else expect(identity).toBe(REPO_UNKNOWN)
  })
})

describe('provenanceUpdate', () => {
  const hash = 'a'.repeat(40)
  const repo = 'github.com/lifinance/contracts'

  it('sets both fields on a record that has them', () => {
    expect(provenanceUpdate({ gitCommitHash: hash, repo }).set).toEqual({
      gitCommitHash: hash,
      repo,
    })
  })

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('leaves a %s repository alone rather than blanking Mongo', (_l, value) => {
    // The JSON sync path carries neither field, and the add CLI writes them to
    // Mongo only, so setting them from a JSON record erases what is there.
    const update = provenanceUpdate({ gitCommitHash: '', repo: value })

    expect(update.set).not.toHaveProperty('repo')
    expect(update.setOnInsert).not.toHaveProperty('repo')
  })

  it('records the sentinel on insert but never over an existing value', () => {
    // A re-run from a checkout with no origin must not downgrade a record that
    // already names its repository, yet a fresh record has to say the capture
    // ran and failed rather than look like it predates the field.
    const update = provenanceUpdate({ gitCommitHash: hash, repo: REPO_UNKNOWN })

    expect(update.set).not.toHaveProperty('repo')
    expect(update.setOnInsert).toHaveProperty('repo', REPO_UNKNOWN)
  })

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('never blanks a %s commit hash either', (_l, value) => {
    // The rule this function inherited, and the only record of it now that the
    // call sites delegate: a JSON-sourced record must not erase a real hash.
    const update = provenanceUpdate({ gitCommitHash: value as string, repo })

    expect(update.set).not.toHaveProperty('gitCommitHash')
    expect(update.setOnInsert).toHaveProperty('gitCommitHash', '')
  })

  it('sets a real commit hash and claims nothing on insert', () => {
    const update = provenanceUpdate({ gitCommitHash: hash })

    expect(update.set).toHaveProperty('gitCommitHash', hash)
    expect(update.setOnInsert).not.toHaveProperty('gitCommitHash')
  })
})
