/**
 * Covers the repository identity a deployment record stores: what a remote URL
 * reduces to, what never leaves the parser, and how the two provenance fields
 * are split across an upsert.
 */

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

describe('REPO_UNKNOWN', () => {
  it('is the uppercase sentinel the deployment log already standardised on', () => {
    // Asserted as a literal on purpose: every other test compares against the
    // imported constant, so changing its value would otherwise pass them all
    // while collapsing the "ran and failed" and "predates the field" states
    // that the rest of this module exists to keep apart.
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
  ])('reduces %s to one identity', (_label, url) => {
    expect(normalizeRepoUrl(url)).toBe('github.com/lifinance/contracts')
  })

  it.each([
    [
      'github over port 443',
      'ssh://git@ssh.github.com:443/lifinance/contracts.git',
    ],
    [
      'gitlab over port 443',
      'ssh://git@altssh.gitlab.com:443/lifinance/contracts.git',
    ],
  ])('folds %s onto its canonical host', (_label, url) => {
    // Both are published SSH endpoints for networks that block port 22. Left
    // alone, one developer behind a corporate firewall records an identity that
    // compares unequal to everyone else's for the same repository.
    expect(normalizeRepoUrl(url)).toMatch(
      /^(github|gitlab)\.com\/lifinance\/contracts$/
    )
  })

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
   * Every one of these reached the output of an earlier revision of this
   * parser, which tried an scp-style match on strings that already had a
   * scheme and anchored the userinfo to the FIRST `@` rather than the last.
   * A token with a `/` or an `@` in it therefore survived into the record.
   */
  const CREDENTIAL_BEARING = [
    [
      'slash in the password',
      'https://user:pa/ss@github.com/lifinance/contracts',
    ],
    [
      'at sign in the password',
      'https://user:p@ssword@github.com/lifinance/contracts',
    ],
    [
      'github token after an at',
      'https://x-access-token:gh@p_SECRET@github.com/lifinance/contracts.git',
    ],
    [
      'base64 token with a slash',
      'https://lifi:zK3n/AbC+dEf9@dev.azure.com/lifi/contracts/_git/contracts',
    ],
    [
      'aws codecommit style',
      'https://danb-at-1234:ab9/xq+token3d@git-codecommit.eu-central-1.amazonaws.com/v1/repos/contracts',
    ],
    [
      'plain userinfo',
      'https://x-access-token:ghp_PLAINTOKEN@github.com/lifinance/contracts.git',
    ],
    [
      'user and password',
      'https://user:hunter2@github.com/lifinance/contracts.git',
    ],
    [
      'token in a query string',
      'https://github.com/lifinance/contracts.git?token=ghp_QUERYTOKEN',
    ],
  ] as const

  it.each(CREDENTIAL_BEARING)('drops %s', (_label, url) => {
    const identity = normalizeRepoUrl(url)

    expect(identity).not.toContain('@')
    expect(identity.toLowerCase()).not.toMatch(
      /ghp_|glpat|hunter2|secret|token3d|zk3n|abc\+def/
    )
  })

  it('emits nothing but the sentinel or a host and path, for every input tried', () => {
    // The guarantee the record depends on, asserted over the whole corpus at
    // once rather than input by input: anything that is not a clean identity
    // must be the sentinel, never a partially-parsed string.
    for (const [, url] of CREDENTIAL_BEARING) {
      const identity = normalizeRepoUrl(url)

      expect(
        identity === REPO_UNKNOWN ||
          /^[a-z0-9.-]+(\/[^/@:\s]+)+$/.test(identity)
      ).toBe(true)
    }
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n'],
    ['a local path', '/Users/someone/Documents/GitHub/contracts'],
    ['a relative path', '../contracts.git'],
    ['a bare word', 'origin'],
    ['a file url', 'file:///Users/dev/contracts'],
    ['a windows path', 'C:/Users/dev/contracts'],
    ['a host with no path', 'https://github.com/'],
  ])('reports %p as unknown rather than echoing it back', (_label, url) => {
    expect(normalizeRepoUrl(url)).toBe(REPO_UNKNOWN)
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

  it('identifies this checkout through the real subprocess', () => {
    // The one case that exercises the production runner against real git,
    // rather than the injected seam.
    const identity = getCurrentRepo()

    expect(identity).not.toBe(REPO_UNKNOWN)
    expect(identity).not.toContain('@')
    expect(identity.split('/')).toHaveLength(3)
    expect(identity.endsWith('/contracts')).toBe(true)
  })
})

describe('provenanceUpdate', () => {
  const hash = 'a'.repeat(40)

  it.each([['a real repository', 'github.com/lifinance/contracts']])(
    'sets %s on both new and existing records',
    (_label, repo) => {
      expect(provenanceUpdate({ gitCommitHash: hash, repo }).set).toEqual({
        gitCommitHash: hash,
        repo,
      })
    }
  )

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('leaves a %s repository alone rather than blanking Mongo', (_l, repo) => {
    // The JSON sync path carries neither field, and the add CLI writes them to
    // Mongo only, so setting them from a JSON record erases what is there.
    const update = provenanceUpdate({ gitCommitHash: '', repo })

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

  it('keeps the commit hash behaviour it inherited', () => {
    expect(provenanceUpdate({ gitCommitHash: hash }).set).toHaveProperty(
      'gitCommitHash',
      hash
    )
    expect(provenanceUpdate({ gitCommitHash: '' }).setOnInsert).toHaveProperty(
      'gitCommitHash',
      ''
    )
    expect(
      provenanceUpdate({ gitCommitHash: hash }).setOnInsert
    ).not.toHaveProperty('gitCommitHash')
  })
})
