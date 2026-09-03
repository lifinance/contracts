/**
 * Per-run verdict cache for the production deploy gate in `verify-approvals.ts`.
 *
 * The gate is invoked once per *(network, facet)*, but, for a fixed branch and
 * environment, its verdict depends only on the working tree and the facet set — never on
 * the network. Uncached, a 71-network rollout
 * recomputes the identical answer 71 times, each paying an `ls-remote` (and a
 * `gh pr list` whenever a facet diverges) and giving a flaky remote 71 chances to abort
 * the rollout fail-closed; worse, the concurrent workers of
 * `proposeContractToNetworks.sh` all reach `resolveMainRef` at once and race each other's
 * `git fetch` on `refs/remotes/origin/main.lock`.
 *
 * Two properties keep this from weakening the gate it speeds up:
 *
 * - **Only a pass is ever cached.** A failing gate aborts the rollout, so there is no
 *   repetition to save there, and a cached failure could outlive its cause (an opened PR,
 *   a landed merge) and block a deploy that should now proceed. A cache entry can
 *   therefore never turn a pass into a failure.
 * - **Anything unexpected is a miss, never a pass.** An unreadable, unparsable, expired,
 *   or non-matching entry, or a git command that fails while the key is being built, all
 *   fall through to the real check.
 *
 * The tradeoff, and the reason for {@link CACHE_TTL_MS}: the rollout is judged against
 * `origin/main`, and against the open-PR lookup, as they stood at its first invocation,
 * so neither `main` moving nor the anchoring PR being closed stops the remaining
 * networks. Both are benign for one operator action on an unchanged tree — the code was
 * merged, or audited and under an open PR, when the verdict was taken. Set
 * `DEPLOY_GATE_SKIP_VERDICT_CACHE=true` to force a fresh verdict.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { consola } from 'consola'

import { EnvironmentEnum } from '../../common/types'

/**
 * How long a cached pass stays usable. Long enough to cover a full fleet rollout, short
 * enough to bound how stale the `origin/main` it was taken against can be. Expiry is
 * cheap: the next invocation simply recomputes and re-caches.
 */
export const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_DIR_NAME = 'lifi-deploy-gate-cache'
const SKIP_ENV_VAR = 'DEPLOY_GATE_SKIP_VERDICT_CACHE'
/** Generous enough to cover one full check (an `ls-remote` alone can take seconds). */
const LOCK_WAIT_MS = 120_000
const LOCK_POLL_MS = 150
/** A lock older than this belonged to a process that died before releasing it. */
const LOCK_STALE_MS = 5 * 60 * 1000

/** What the gate was asked to rule on. The network is deliberately not part of it. */
export interface IVerdictCacheInput {
  environment: string
  branch: string
  facets: string[]
}

/** A recorded pass. Its presence, once validated, *is* the verdict. */
interface ICachedPass {
  key: string
  createdAt: number
  branch: string
  facets: string[]
}

const git = (
  args: string[],
  cwd: string
): { status: number; stdout: string } => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // a working tree with thousands of changed files must not truncate the fingerprint
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })

  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/**
 * Builds the identity of a gate verdict: everything the answer depends on.
 *
 * `HEAD` plus the content of the diff against it pins every tracked file, so a further
 * edit to an already-modified file changes the key — a name-only fingerprint would not,
 * and would let a stale pass cover different content. Untracked files are keyed by name
 * only, which is sufficient: an untracked file in a facet's closure has no counterpart on
 * `origin/main` and so can only ever push the verdict toward failure, whatever it holds.
 * @param repoRoot - repository root
 * @param input - environment, branch, and facet names about to be proposed
 * @returns the key, or `undefined` when it cannot be built and nothing may be cached
 */
export const buildVerdictKey = (
  repoRoot: string,
  input: IVerdictCacheInput
): string | undefined => {
  const head = git(['rev-parse', 'HEAD'], repoRoot)
  const status = git(
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=untracked',
    ],
    repoRoot
  )
  // --binary so a changed binary is not reduced to "Binary files differ"; the
  // submodule setting matches the one divergedSubmodules compares gitlinks with
  const diff = git(
    [
      'diff',
      '--no-ext-diff',
      '--binary',
      '--ignore-submodules=untracked',
      'HEAD',
      '--',
    ],
    repoRoot
  )

  if (head.status !== 0 || status.status !== 0 || diff.status !== 0)
    return undefined

  return JSON.stringify({
    repoRoot,
    environment: input.environment,
    branch: input.branch,
    facets: [...input.facets].sort(),
    head: head.stdout.trim(),
    status: status.stdout,
    diff: diff.stdout,
  })
}

/**
 * Locates the cache directory inside the checkout's own git directory.
 *
 * Not the system temp directory: a world-writable location would let any local process
 * plant a pass for a key it can compute. `.git` is already the trust boundary of the
 * checkout being deployed. Being outside the working tree also keeps the cache from
 * appearing in the `git status` its own key is built from.
 * @param repoRoot - repository root
 * @returns the cache directory, or `undefined` when it cannot be located or created
 */
const resolveCacheDir = (repoRoot: string): string | undefined => {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], repoRoot)
  if (gitDir.status !== 0) return undefined

  const dir = join(gitDir.stdout.trim(), CACHE_DIR_NAME)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return undefined
  }

  return dir
}

const entryPath = (cacheDir: string, key: string): string =>
  join(cacheDir, `${createHash('sha256').update(key).digest('hex')}.json`)

/**
 * Reads a recorded pass, if one is present and still valid for this exact key.
 * @param path - cache entry path
 * @param key - the key the entry must carry
 * @param now - current epoch milliseconds
 * @returns the entry, or `undefined` for any reason at all
 */
const readPass = (
  path: string,
  key: string,
  now: number
): ICachedPass | undefined => {
  let entry: ICachedPass
  try {
    entry = JSON.parse(readFileSync(path, 'utf8')) as ICachedPass
  } catch {
    return undefined
  }

  // the full key is compared, not just the hash its filename is made of, so a
  // truncated or colliding name cannot stand in for a different tree
  if (entry?.key !== key) return undefined
  if (typeof entry.createdAt !== 'number') return undefined
  if (now - entry.createdAt > CACHE_TTL_MS || entry.createdAt > now)
    return undefined

  return entry
}

const writePass = (path: string, entry: ICachedPass): void => {
  try {
    // rename so a reader can never observe a half-written entry
    const staging = `${path}.${process.pid}.tmp`
    writeFileSync(staging, JSON.stringify(entry))
    renameSync(staging, path)
  } catch {
    // a cache that cannot be written costs speed, never correctness
  }
}

/**
 * Outcome of one attempt at the single-flight lock. `unavailable` is kept apart from
 * `held` on purpose: waiting out the full {@link LOCK_WAIT_MS} for a lock that can never
 * be created would stall every invocation of a rollout for two minutes.
 */
type TLockAttempt = 'acquired' | 'held' | 'unavailable'

const isAlreadyExists = (error: unknown): boolean =>
  (error as { code?: string })?.code === 'EEXIST'

const OWNER_FILE = 'owner'

/**
 * Claims the lock directory for `owner` by writing its token inside. Not atomic with
 * the `mkdirSync` that created the directory, but that is fine: the directory's mere
 * existence is what `EEXIST` guards, and the owner file only matters at release time.
 */
const claimLock = (lockDir: string, owner: string): void => {
  writeFileSync(join(lockDir, OWNER_FILE), owner)
}

/**
 * Takes the single-flight lock, so that concurrent rollout workers do not all run the
 * check — and, more to the point, do not all `git fetch` the same ref at once and race
 * on `refs/remotes/origin/main.lock`.
 * @param lockDir - lock directory to create
 * @param owner - this caller's token, written into the lock so a later, unrelated
 * holder cannot be released by someone who no longer holds it (see {@link releaseLock})
 * @param now - current epoch milliseconds
 * @returns whether the lock was taken, is held elsewhere, or cannot be taken at all
 */
const acquireLock = (
  lockDir: string,
  owner: string,
  now: number
): TLockAttempt => {
  try {
    mkdirSync(lockDir)
    claimLock(lockDir, owner)
    return 'acquired'
  } catch (error) {
    if (!isAlreadyExists(error)) return 'unavailable'
  }

  try {
    if (now - statSync(lockDir).mtimeMs < LOCK_STALE_MS) return 'held'

    // claiming the stale lock by rename rather than removing it in place: rename is
    // atomic, so of two waiters that both saw it as stale exactly one succeeds and the
    // other gets ENOENT. Removing in place lets the loser delete the winner's fresh
    // lock and leaves both of them running the check at once.
    const claimed = `${lockDir}.stale.${process.pid}`
    renameSync(lockDir, claimed)
    rmSync(claimed, { recursive: true, force: true })
  } catch {
    return 'held'
  }

  try {
    mkdirSync(lockDir)
    claimLock(lockDir, owner)
    return 'acquired'
  } catch (error) {
    // someone acquired it between the takeover and here; they hold it, not us
    return isAlreadyExists(error) ? 'held' : 'unavailable'
  }
}

/**
 * Releases the lock, but only if `owner` is still the one recorded inside it.
 *
 * A holder that outlives {@link LOCK_STALE_MS} (a slow `compute`, a suspended process)
 * can wake up after a waiter has already claimed the lock as stale and reacquired it for
 * itself. Without this check, the slow holder's own `finally` block would then remove
 * the successor's live lock out from under it. Checking the owner token first means a
 * holder that lost the lock to a takeover finds someone else's name inside and leaves it
 * alone.
 */
const releaseLock = (lockDir: string, owner: string): void => {
  try {
    if (readFileSync(join(lockDir, OWNER_FILE), 'utf8') !== owner) return
    rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // a lock that cannot be removed ages out as stale
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `compute` at most once per verdict for as long as the tree stays put, reusing a
 * recorded pass across the invocations of a rollout.
 *
 * Only production is cached: staging and unrecognised environments are decided without
 * touching the network, so there is nothing to save.
 * @param repoRoot - repository root
 * @param input - environment, branch, and facet names about to be proposed
 * @param compute - the real check; run whenever a pass cannot be reused
 * @param now - current epoch milliseconds; injectable for tests
 * @returns one message per violation; empty when the deploy may proceed
 */
export const withVerdictCache = async (
  repoRoot: string,
  input: IVerdictCacheInput,
  compute: () => Promise<string[]>,
  now: () => number = Date.now
): Promise<string[]> => {
  if (input.environment !== EnvironmentEnum.production) return compute()
  if (process.env[SKIP_ENV_VAR] === 'true') return compute()

  const key = buildVerdictKey(repoRoot, input)
  const cacheDir = key === undefined ? undefined : resolveCacheDir(repoRoot)
  if (key === undefined || cacheDir === undefined) return compute()

  const path = entryPath(cacheDir, key)
  const lockDir = `${path}.lock`

  const reuse = (entry: ICachedPass): string[] => {
    consola.info(
      `reusing the deploy gate pass recorded ${Math.round(
        (now() - entry.createdAt) / 1000
      )}s ago for ${entry.facets.join(', ')} on "${
        entry.branch
      }" (set ${SKIP_ENV_VAR}=true to force a fresh verdict)`
    )

    return []
  }

  const cached = readPass(path, key, now())
  if (cached) return reuse(cached)

  // waiting rather than computing alongside the holder is the point: it is what keeps
  // the rollout's workers from fetching the same ref concurrently. A holder that
  // releases without recording a pass did not pass, so the next waiter takes its turn.
  const owner = randomUUID()
  const deadline = now() + LOCK_WAIT_MS
  let attempt = acquireLock(lockDir, owner, now())
  while (attempt !== 'acquired') {
    if (attempt === 'unavailable') return compute()

    const waited = readPass(path, key, now())
    if (waited) return reuse(waited)
    if (now() >= deadline) return compute()

    await sleep(LOCK_POLL_MS)
    attempt = acquireLock(lockDir, owner, now())
  }

  try {
    // another worker may have recorded a pass between the read above and this lock
    const raced = readPass(path, key, now())
    if (raced) return reuse(raced)

    const failures = await compute()
    if (failures.length === 0)
      writePass(path, {
        key,
        createdAt: now(),
        branch: input.branch,
        facets: input.facets,
      })

    return failures
  } finally {
    releaseLock(lockDir, owner)
  }
}
