/**
 * A deployment record names the commit a rebuild should happen at. Without the
 * repository that commit lives in, the name is ambiguous: the same hash can
 * exist in a fork, and a verifier that resolves it anywhere will resolve it
 * everywhere.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { REPO_UNKNOWN, normalizeRepoUrl } from './repo-identity'

describe('normalizeRepoUrl', () => {
  it.each([
    ['scp-style ssh', 'git@github.com:lifinance/contracts.git'],
    ['https with suffix', 'https://github.com/lifinance/contracts.git'],
    ['https without suffix', 'https://github.com/lifinance/contracts'],
    ['ssh:// url', 'ssh://git@github.com/lifinance/contracts.git'],
    ['trailing slash', 'https://github.com/lifinance/contracts/'],
    ['trailing newline', 'git@github.com:lifinance/contracts.git\n'],
    ['non-standard port', 'ssh://git@github.com:22/lifinance/contracts.git'],
  ])('reduces %s to one identity', (_label, url) => {
    expect(normalizeRepoUrl(url)).toBe('github.com/lifinance/contracts')
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

  it.each([
    [
      'userinfo with a token',
      'https://x-access-token:ghp_SECRETVALUE@github.com/lifinance/contracts.git',
    ],
    [
      'user and password',
      'https://user:hunter2@github.com/lifinance/contracts.git',
    ],
  ])('drops %s rather than recording it', (_label, url) => {
    const identity = normalizeRepoUrl(url)

    expect(identity).toBe('github.com/lifinance/contracts')
    expect(identity).not.toMatch(/ghp_|hunter2|@/)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n'],
    ['a local path', '/Users/someone/Documents/GitHub/contracts'],
    ['a relative path', '../contracts.git'],
    ['a bare word', 'origin'],
  ])('reports %p as unknown rather than echoing it back', (_label, url) => {
    // Only a recognised host/path shape is ever emitted. Anything else could
    // carry credentials in a form this does not parse, and a record is not the
    // place to find out.
    expect(normalizeRepoUrl(url)).toBe(REPO_UNKNOWN)
  })

  it('never emits a value containing an @, whatever it is given', () => {
    for (const url of [
      'https://tok@github.com/a/b.git',
      'git@github.com:a/b.git',
      'ssh://git@host/a/b',
      'garbage@@@',
    ])
      expect(normalizeRepoUrl(url)).not.toContain('@')
  })
})

describe('getCurrentRepo', () => {
  const runInProcess = (stubDir?: string): string => {
    const script = join(tmpdir(), `repo-identity-probe-${Date.now()}.ts`)
    writeFileSync(
      script,
      `import { getCurrentRepo } from '${join(
        import.meta.dir,
        'mongo-log-utils'
      )}'\n` + `process.stdout.write(getCurrentRepo())\n`
    )
    const result = spawnSync(process.execPath, [script], {
      cwd: import.meta.dir,
      encoding: 'utf8',
      env: stubDir
        ? { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }
        : process.env,
    })
    return result.stdout.trim()
  }

  it('identifies this checkout from its real origin remote', () => {
    const identity = runInProcess()

    expect(identity).not.toBe(REPO_UNKNOWN)
    expect(identity).toMatch(/^[a-z0-9.-]+\/[^/]+\/contracts$/)
  })

  it('falls back to the sentinel when git cannot name a remote', () => {
    // Fail closed and visibly. A record whose repository is silently blank is
    // indistinguishable from one written before the field existed.
    const stubDir = mkdtempSync(join(tmpdir(), 'repo-identity-git-'))
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(stubDir, 'git'),
      `#!/bin/bash\n[ "$1" = "remote" ] && exit 128\nexec ${real} "$@"\n`
    )
    chmodSync(join(stubDir, 'git'), 0o755)

    expect(runInProcess(stubDir)).toBe(REPO_UNKNOWN)
  })
})

describe('the repo field travels with the commit hash', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', 'update-deployment-logs.ts'),
    'utf8'
  )

  it('guards repo wherever it guards the commit hash on an upsert', () => {
    // A JSON-sourced record carries neither field, so an unguarded `$set` would
    // blank a repository Mongo already holds. This pins the coupling rather
    // than the behaviour: it does not prove either guard works, it fails when a
    // third upsert path adds one without the other.
    const neverBlankHash = new RegExp(
      String.raw`record\.gitCommitHash\s*\n?\s*\?\s*\{ gitCommitHash: record\.gitCommitHash \}`,
      'g'
    )
    const guardedHash = source.match(neverBlankHash) ?? []
    const guardedRepo = source.match(/record\.repo \? \{ repo:/g) ?? []

    expect(guardedHash.length).toBeGreaterThan(0)
    expect(guardedRepo).toHaveLength(guardedHash.length)
  })

  it('captures the repository at the same point it captures the hash', () => {
    const capture = source
      .split('\n')
      .findIndex((line) =>
        line.includes('gitCommitHash: getCurrentGitCommitHash()')
      )

    expect(capture).toBeGreaterThan(-1)
    expect(source.split('\n')[capture + 1]).toContain('repo: getCurrentRepo()')
  })
})
