/**
 * Tests for the deploy gate's per-run verdict cache.
 *
 * The cache sits in front of a security control, so the cases below are written to
 * falsify the two properties that keep it safe: a pass is reused only for the exact tree
 * it was taken on, and nothing but a pass is ever reused.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { EnvironmentEnum } from '../../common/types'

import {
  buildVerdictKey,
  CACHE_TTL_MS,
  withVerdictCache,
} from './deploy-gate-cache'

const SKIP_ENV_VAR = 'DEPLOY_GATE_SKIP_VERDICT_CACHE'
const FACET_PATH = 'src/Facets/TestFacet.sol'
const FACET_SOURCE =
  '// SPDX-License-Identifier: LGPL-3.0-only\ncontract T {}\n'

const PROD_INPUT = {
  environment: EnvironmentEnum.production,
  branch: 'deploy/across',
  facets: ['AcrossFacet'],
}

const runGit = (repoRoot: string, ...args: string[]) =>
  spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

/**
 * Initialises a repo with one committed facet.
 * @param prefix - temp directory prefix
 * @returns the repository root
 */
const initRepo = (prefix: string): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix))
  runGit(repoRoot, 'init', '-b', 'main')
  runGit(repoRoot, 'config', 'user.email', 'gate@example.com')
  runGit(repoRoot, 'config', 'user.name', 'gate')
  mkdirSync(join(repoRoot, 'src', 'Facets'), { recursive: true })
  writeFileSync(join(repoRoot, FACET_PATH), FACET_SOURCE)
  runGit(repoRoot, 'add', '.')
  runGit(repoRoot, 'commit', '-m', 'initial', '--no-gpg-sign')

  return repoRoot
}

/** Wires the repo to a local bare origin so the gate's `ls-remote` works offline. */
const initRepoWithRemote = (prefix: string): string => {
  const repoRoot = initRepo(prefix)
  const remote = mkdtempSync(join(tmpdir(), 'cache-remote-'))
  spawnSync('git', ['init', '--bare', '-b', 'main', remote])
  runGit(repoRoot, 'remote', 'add', 'origin', remote)
  runGit(repoRoot, 'push', '-q', 'origin', 'main')

  return repoRoot
}

const cacheDirOf = (repoRoot: string): string =>
  join(repoRoot, '.git', 'lifi-deploy-gate-cache')

/**
 * Resolves the single cache entry a fixture produced.
 * @param dir - cache directory
 * @returns path to the entry
 */
const onlyEntry = (dir: string): string => {
  const [name] = readdirSync(dir).filter((file) => file.endsWith('.json'))
  if (name === undefined) throw new Error(`no cache entry under ${dir}`)

  return join(dir, name)
}

/** A `compute` that records how often it ran. */
const counting = (failures: string[] = []) => {
  const calls = { count: 0 }
  return {
    calls,
    compute: async (): Promise<string[]> => {
      calls.count += 1
      return failures
    },
  }
}

describe('buildVerdictKey', () => {
  it('returns undefined outside a git repo, so nothing is cached', () => {
    expect(
      buildVerdictKey(mkdtempSync(join(tmpdir(), 'cache-nogit-')), PROD_INPUT)
    ).toBeUndefined()
  })

  it('is stable across invocations on an unchanged tree', () => {
    const repoRoot = initRepo('cache-key-stable-')

    expect(buildVerdictKey(repoRoot, PROD_INPUT)).toBe(
      buildVerdictKey(repoRoot, PROD_INPUT) as string
    )
  })

  // the point of keying on the diff content rather than on `git status` names: an
  // already-modified file edited again produces identical porcelain output, so a
  // name-only key would hand the new content a pass taken on the old one
  it('changes when an already-modified file is edited again', () => {
    const repoRoot = initRepo('cache-key-edit-')
    writeFileSync(join(repoRoot, FACET_PATH), `${FACET_SOURCE}// first\n`)
    const statusBefore = runGit(repoRoot, 'status', '--porcelain').stdout
    const before = buildVerdictKey(repoRoot, PROD_INPUT)

    writeFileSync(join(repoRoot, FACET_PATH), `${FACET_SOURCE}// second\n`)

    expect(runGit(repoRoot, 'status', '--porcelain').stdout).toBe(statusBefore)
    expect(buildVerdictKey(repoRoot, PROD_INPUT)).not.toBe(before as string)
  })

  it('changes when an untracked source file appears', () => {
    const repoRoot = initRepo('cache-key-untracked-')
    const before = buildVerdictKey(repoRoot, PROD_INPUT)
    writeFileSync(join(repoRoot, 'src', 'Facets', 'New.sol'), FACET_SOURCE)

    expect(buildVerdictKey(repoRoot, PROD_INPUT)).not.toBe(before as string)
  })

  it('changes when a commit is made without touching the tree', () => {
    const repoRoot = initRepo('cache-key-commit-')
    const before = buildVerdictKey(repoRoot, PROD_INPUT)
    writeFileSync(join(repoRoot, FACET_PATH), `${FACET_SOURCE}// change\n`)
    runGit(repoRoot, 'commit', '-am', 'second', '--no-gpg-sign')

    expect(buildVerdictKey(repoRoot, PROD_INPUT)).not.toBe(before as string)
  })

  it.each([
    ['branch', { ...PROD_INPUT, branch: 'deploy/other' }],
    ['facet set', { ...PROD_INPUT, facets: ['AcrossFacet', 'GenericSwap'] }],
    ['environment', { ...PROD_INPUT, environment: 'staging' }],
  ])('changes with the %s it was taken for', (_label, input) => {
    const repoRoot = initRepo('cache-key-input-')

    expect(buildVerdictKey(repoRoot, input)).not.toBe(
      buildVerdictKey(repoRoot, PROD_INPUT) as string
    )
  })

  // the same rollout may hand the facets over in any order; the verdict is the same
  it('ignores the order the facets are listed in', () => {
    const repoRoot = initRepo('cache-key-order-')

    expect(
      buildVerdictKey(repoRoot, { ...PROD_INPUT, facets: ['B', 'A'] })
    ).toBe(
      buildVerdictKey(repoRoot, { ...PROD_INPUT, facets: ['A', 'B'] }) as string
    )
  })

  // the network is what the cache exists to factor out: the same tree and facet set
  // must key the same for every network in a rollout
  it('has no network in it', () => {
    const repoRoot = initRepo('cache-key-network-')
    const key = buildVerdictKey(repoRoot, PROD_INPUT) as string

    for (const network of ['mainnet', 'arbitrum', 'base'])
      expect(key).not.toContain(network)
  })
})

describe('buildVerdictKey and lib/ submodules', () => {
  /**
   * Builds a superproject pinning a submodule, the shape `divergedSubmodules` blocks on.
   * @returns the superproject root, the submodule path, and its second commit
   */
  const makeSuperproject = () => {
    const dep = mkdtempSync(join(tmpdir(), 'cache-dep-'))
    const runDep = (...args: string[]) =>
      spawnSync('git', args, { cwd: dep, encoding: 'utf8' })
    runDep('init', '-b', 'main')
    runDep('config', 'user.email', 'gate@example.com')
    runDep('config', 'user.name', 'gate')
    writeFileSync(join(dep, 'Lib.sol'), 'contract Lib { }\n')
    runDep('add', '.')
    runDep('commit', '-m', 'v1', '--no-gpg-sign')
    const pinned = runDep('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(dep, 'Lib.sol'), 'contract Lib { uint256 public x; }\n')
    runDep('commit', '-qam', 'v2', '--no-gpg-sign')

    const repoRoot = mkdtempSync(join(tmpdir(), 'cache-super-'))
    runGit(repoRoot, 'init', '-b', 'main')
    runGit(repoRoot, 'config', 'user.email', 'gate@example.com')
    runGit(repoRoot, 'config', 'user.name', 'gate')
    runGit(
      repoRoot,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      dep,
      'lib/dep'
    )
    const subPath = join(repoRoot, 'lib/dep')
    spawnSync('git', ['checkout', '-q', pinned], { cwd: subPath })
    mkdirSync(join(repoRoot, 'src', 'Facets'), { recursive: true })
    writeFileSync(join(repoRoot, FACET_PATH), FACET_SOURCE)
    runGit(repoRoot, 'add', '-A')
    runGit(repoRoot, 'commit', '-m', 'pin dep', '--no-gpg-sign')

    return { repoRoot, subPath }
  }

  // `lib/` content is not in this repo's tree, so the key covers it through the gitlink.
  // Were it not covered, a pass taken on a clean checkout would be reused across exactly
  // the divergence the gate refuses.
  it('changes when a submodule moves off its recorded commit', () => {
    const { repoRoot, subPath } = makeSuperproject()
    const before = buildVerdictKey(repoRoot, PROD_INPUT)
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: subPath })

    expect(buildVerdictKey(repoRoot, PROD_INPUT)).not.toBe(before as string)
  })

  it('changes when a submodule has a modified tracked file', () => {
    const { repoRoot, subPath } = makeSuperproject()
    const before = buildVerdictKey(repoRoot, PROD_INPUT)
    writeFileSync(join(subPath, 'Lib.sol'), 'contract Lib { bool tampered; }\n')

    expect(buildVerdictKey(repoRoot, PROD_INPUT)).not.toBe(before as string)
  })

  // matching the gate's own `--ignore-submodules=untracked`: a stray file changes no
  // bytecode, and keying on it would throw the cache away after one Finder visit
  it('ignores a stray untracked file inside a submodule', () => {
    const { repoRoot, subPath } = makeSuperproject()
    const before = buildVerdictKey(repoRoot, PROD_INPUT)
    writeFileSync(join(subPath, '.DS_Store'), 'junk\n')

    expect(buildVerdictKey(repoRoot, PROD_INPUT)).toBe(before as string)
  })
})

describe('withVerdictCache', () => {
  afterEach(() => {
    delete process.env[SKIP_ENV_VAR]
  })

  it('runs the check once and reuses the pass for the next network', async () => {
    const repoRoot = initRepo('cache-reuse-')
    const { calls, compute } = counting()

    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])
    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])
    expect(calls.count).toBe(1)
  })

  // a failing gate aborts the rollout, so there is nothing to save by caching it - and
  // a cached failure could outlive the PR that was opened to satisfy it
  it('never caches a failure', async () => {
    const repoRoot = initRepo('cache-failure-')
    const { calls, compute } = counting(['no open PR found'])

    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([
      'no open PR found',
    ])
    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([
      'no open PR found',
    ])
    expect(calls.count).toBe(2)
  })

  it('recomputes once the recorded pass has aged out', async () => {
    const repoRoot = initRepo('cache-ttl-')
    const { calls, compute } = counting()
    const start = 1_700_000_000_000

    await withVerdictCache(repoRoot, PROD_INPUT, compute, () => start)
    await withVerdictCache(
      repoRoot,
      PROD_INPUT,
      compute,
      () => start + CACHE_TTL_MS + 1
    )

    expect(calls.count).toBe(2)
  })

  it('reuses a pass that is still inside the window', async () => {
    const repoRoot = initRepo('cache-ttl-ok-')
    const { calls, compute } = counting()
    const start = 1_700_000_000_000

    await withVerdictCache(repoRoot, PROD_INPUT, compute, () => start)
    await withVerdictCache(
      repoRoot,
      PROD_INPUT,
      compute,
      () => start + CACHE_TTL_MS - 1
    )

    expect(calls.count).toBe(1)
  })

  it('recomputes when the tree changes under a recorded pass', async () => {
    const repoRoot = initRepo('cache-dirty-')
    const { calls, compute } = counting()

    await withVerdictCache(repoRoot, PROD_INPUT, compute)
    writeFileSync(join(repoRoot, FACET_PATH), `${FACET_SOURCE}// edited\n`)
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    expect(calls.count).toBe(2)
  })

  it.each([
    ['staging', EnvironmentEnum.staging],
    ['an unrecognised environment', 'prod'],
  ])('does not cache %s', async (_label, environment) => {
    const repoRoot = initRepo('cache-nonprod-')
    const { calls, compute } = counting()
    const input = { ...PROD_INPUT, environment }

    await withVerdictCache(repoRoot, input, compute)
    await withVerdictCache(repoRoot, input, compute)

    expect(calls.count).toBe(2)
    expect(existsSync(cacheDirOf(repoRoot))).toBe(false)
  })

  it('recomputes on every call once the skip flag is set', async () => {
    const repoRoot = initRepo('cache-skip-')
    const { calls, compute } = counting()

    await withVerdictCache(repoRoot, PROD_INPUT, compute)
    process.env[SKIP_ENV_VAR] = 'true'
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    expect(calls.count).toBe(2)
  })

  // a planted entry is the obvious way to attack a cached security verdict: the full key
  // is compared, not just the filename hash it is stored under
  it('ignores an entry whose key does not match the tree', async () => {
    const repoRoot = initRepo('cache-planted-')
    const { calls, compute } = counting()
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    const dir = cacheDirOf(repoRoot)
    const entry = onlyEntry(dir)
    writeFileSync(
      entry,
      JSON.stringify({
        key: 'some other tree',
        createdAt: Date.now(),
        branch: PROD_INPUT.branch,
        facets: PROD_INPUT.facets,
      })
    )

    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])
    expect(calls.count).toBe(2)
  })

  it.each([
    ['unparsable', 'not json at all'],
    ['unkeyed', JSON.stringify({ createdAt: Date.now() })],
    ['undated', JSON.stringify({ key: 'x', createdAt: 'yesterday' })],
  ])('treats an %s entry as a miss', async (_label, contents) => {
    const repoRoot = initRepo('cache-corrupt-')
    const { calls, compute } = counting()
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    const dir = cacheDirOf(repoRoot)
    writeFileSync(onlyEntry(dir), contents)

    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])
    expect(calls.count).toBe(2)
  })

  // concurrent rollout workers all reaching the check at once is what raced
  // `git fetch` on refs/remotes/origin/main.lock
  it('runs the check once for concurrent callers', async () => {
    const repoRoot = initRepo('cache-concurrent-')
    const calls = { count: 0 }
    const compute = async (): Promise<string[]> => {
      calls.count += 1
      await new Promise((resolve) => setTimeout(resolve, 300))
      return []
    }

    const verdicts = await Promise.all(
      Array.from({ length: 5 }, () =>
        withVerdictCache(repoRoot, PROD_INPUT, compute)
      )
    )

    expect(verdicts).toEqual([[], [], [], [], []])
    expect(calls.count).toBe(1)
  })

  // inside the working tree, the cache would show up in the `git status` its own key is
  // built from, and would invalidate itself on every write
  it('keeps the cache out of the working tree', async () => {
    const repoRoot = initRepo('cache-location-')
    await withVerdictCache(repoRoot, PROD_INPUT, counting().compute)

    expect(existsSync(cacheDirOf(repoRoot))).toBe(true)
    expect(runGit(repoRoot, 'status', '--porcelain').stdout.trim()).toBe('')
  })

  // a holder killed mid-check leaves its lock behind; without a takeover every later
  // invocation would stall on it for the full wait before deciding for itself
  it('takes over a lock left behind by a dead holder', async () => {
    const repoRoot = initRepo('cache-stale-lock-')
    const { calls, compute } = counting()
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    const dir = cacheDirOf(repoRoot)
    const entry = onlyEntry(dir)
    unlinkSync(entry)
    const lockDir = `${entry}.lock`
    mkdirSync(lockDir)
    const longAgo = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(lockDir, longAgo, longAgo)

    const started = Date.now()
    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])

    expect(calls.count).toBe(2)
    expect(Date.now() - started).toBeLessThan(5_000)
    // the stale lock is claimed by rename, so no claim directory may survive either
    expect(readdirSync(dir).filter((name) => name.includes('.stale.'))).toEqual(
      []
    )
  })

  it('waits on a lock a live holder still owns rather than checking alongside it', async () => {
    const repoRoot = initRepo('cache-fresh-lock-')
    const { calls, compute } = counting()
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    const dir = cacheDirOf(repoRoot)
    const entry = onlyEntry(dir)
    const key = JSON.parse(readFileSync(entry, 'utf8')).key as string
    unlinkSync(entry)
    mkdirSync(`${entry}.lock`)

    // the holder finishes and records its pass while this caller is polling
    setTimeout(() => {
      writeFileSync(
        entry,
        JSON.stringify({
          key,
          createdAt: Date.now(),
          branch: PROD_INPUT.branch,
          facets: PROD_INPUT.facets,
        })
      )
    }, 400)

    expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])
    expect(calls.count).toBe(1)
  })

  // a lock that cannot be created is not a lock someone holds: waiting out the full
  // two-minute window for it would stall every invocation of the rollout
  it('checks immediately when the lock cannot be created at all', async () => {
    const repoRoot = initRepo('cache-unlockable-')
    const { calls, compute } = counting()
    await withVerdictCache(repoRoot, PROD_INPUT, compute)

    const dir = cacheDirOf(repoRoot)
    unlinkSync(onlyEntry(dir))
    chmodSync(dir, 0o500)

    const started = Date.now()
    try {
      expect(await withVerdictCache(repoRoot, PROD_INPUT, compute)).toEqual([])
    } finally {
      chmodSync(dir, 0o700)
    }

    expect(calls.count).toBe(2)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('leaves no lock behind for the next invocation to wait on', async () => {
    const repoRoot = initRepo('cache-lock-')
    await withVerdictCache(repoRoot, PROD_INPUT, async () => {
      throw new Error('gate blew up')
    }).catch(() => undefined)

    expect(
      readdirSync(cacheDirOf(repoRoot)).filter((name) => name.endsWith('.lock'))
    ).toEqual([])
  })
})

describe('verify-approvals CLI with the verdict cache', () => {
  const script = join(import.meta.dir, 'verify-approvals.ts')

  const runCli = (repoRoot: string, env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [
        script,
        '--environment',
        'production',
        '--branch',
        'main',
        '--facets',
        'TestFacet',
      ],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } }
    )

  /**
   * Proves the second invocation consulted no remote, rather than merely being fast:
   * the remote is pointed at a path that does not exist between the two runs, which
   * fails the gate closed whenever it is actually reached.
   */
  it('does not reach the remote again for the next network of a rollout', () => {
    const repoRoot = initRepoWithRemote('cache-cli-')

    const first = runCli(repoRoot)
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('OK')

    runGit(repoRoot, 'remote', 'set-url', 'origin', join(repoRoot, 'gone.git'))

    const second = runCli(repoRoot)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('OK')

    // and the pass really is the only reason it passed
    const forced = runCli(repoRoot, { [SKIP_ENV_VAR]: 'true' })
    expect(forced.status).not.toBe(0)
    expect(forced.stdout).not.toContain('OK')
  })
})
