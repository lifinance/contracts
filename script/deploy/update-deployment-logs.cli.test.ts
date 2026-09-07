/**
 * Placement proof for the deploy-log provenance capture: the `add` CLI has to
 * capture branch, scoped dirty tree and actor from the tree it is invoked in,
 * and carry them into the upsert it applies. `shared/mongo-log-utils.test.ts`
 * covers what the pure functions decide with those values.
 *
 * Each case runs the real CLI in a throwaway git repo, because a tree whose
 * dirtiness the test controls is the only way to observe the capture rather
 * than assume it. `--dryRun` is what keeps the probes off a real store; the
 * store URI is made unparseable as well, so a probe that ignored the flag dies
 * on connect instead of writing.
 *
 * Every absence assertion is paired with a positive marker, and a child killed
 * by a timeout is treated as no result at all.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const ADD_CLI = join(REPO_ROOT, 'script/deploy/update-deployment-logs.ts')

/** Long enough for a bun start-up plus a handful of git probes. */
const TIMEOUT_MS = 60_000
/** Per-case budget: these spawn a real CLI, well past bun's 5 s default. */
const CASE_TIMEOUT_MS = 90_000

const CONTRACT = 'AcrossFacetV4'
const CONTRACT_PATH = `src/Facets/${CONTRACT}.sol`
const ADDRESS = '0x1111111111111111111111111111111111111111'

interface IUpsertShape {
  filter: Record<string, { $eq: unknown }>
  update: {
    $set: Record<string, unknown>
    $setOnInsert: Record<string, unknown>
  }
}

/**
 * Builds a repo on a named branch, optionally leaving one source file dirty.
 * @param options - branch to check out, and whether to diverge the source
 * @returns the repository root
 */
const makeRepo = (options: { branch: string; dirty: boolean }): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'deploy-log-provenance-'))
  const run = (...args: string[]) =>
    spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

  run('init', '-b', options.branch)
  run('config', 'user.email', 'provenance@example.com')
  run('config', 'user.name', 'provenance')
  mkdirSync(join(repoRoot, 'src/Facets'), { recursive: true })
  writeFileSync(
    join(repoRoot, CONTRACT_PATH),
    `// SPDX-License-Identifier: LGPL-3.0-only\ncontract ${CONTRACT} {}\n`
  )
  run('add', '.')
  run('commit', '-m', 'deployed state', '--no-gpg-sign')

  if (options.dirty)
    writeFileSync(
      join(repoRoot, CONTRACT_PATH),
      `// SPDX-License-Identifier: LGPL-3.0-only\ncontract ${CONTRACT} { uint256 public unreviewed; }\n`
    )

  return repoRoot
}

/**
 * Rejects a child whose result cannot be reasoned about, and — first — one that
 * reached a real store. A probe that wrote is the one most likely to look like a
 * timeout, so the breach check runs before the usability checks.
 * @param result - what `spawnSync` returned
 * @param output - the child's combined stdout and stderr
 */
const assertChildIsUsable = (
  result: { error?: Error; signal: NodeJS.Signals | null },
  output: string
): void => {
  if (/Connected to MongoDB|Successfully added\/updated/i.test(output))
    throw new Error(
      'a probe reached a real deployment store — the child environment is not isolated'
    )
  if (result.error) throw result.error
  if (result.signal)
    throw new Error(
      `child was killed by ${result.signal} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )
}

/**
 * Runs the real `add` CLI in a throwaway repo and parses what it would write.
 * @param options - the repo to run in, and extra CLI arguments
 * @returns the child's combined output, exit status, and the parsed upsert
 */
const runAdd = (options: {
  repoRoot: string
  extraArgs?: string[]
}): { output: string; status: number | null; upsert: IUpsertShape } => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // `bun test` sets NODE_ENV=test; this child is exercised as a CLI.
  delete env.NODE_ENV
  // Bun auto-loads the repo env file into THIS process, so the child inherits a
  // real production environment unless every store name is neutralised here.
  // Deliberately malformed rather than unroutable: a driver spends 30 s of
  // server selection on an unreachable host, where a URI it cannot parse throws
  // on construction — so a probe that got past `--dryRun` dies at once.
  env.MONGODB_URI = 'blocked-in-tests://no-store'
  env.SC_MONGODB_URI = env.MONGODB_URI

  const result = spawnSync(
    'bun',
    [
      ADD_CLI,
      'add',
      '--env',
      'staging',
      '--contract',
      CONTRACT,
      '--network',
      'arbitrum',
      '--version',
      '1.0.0',
      '--address',
      ADDRESS,
      '--optimizer-runs',
      '1000000',
      '--timestamp',
      '2026-09-08 00:00:00',
      '--constructor-args',
      '0x',
      '--verified',
      'false',
      '--dryRun',
      ...(options.extraArgs ?? []),
    ],
    {
      cwd: options.repoRoot,
      encoding: 'utf8',
      env,
      timeout: TIMEOUT_MS,
      maxBuffer: Infinity,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  const output = `${result.stdout}${result.stderr}`
  assertChildIsUsable(result, output)

  const start = result.stdout.indexOf('{')
  if (start === -1)
    throw new Error(`the CLI printed no upsert document:\n${output}`)

  return {
    output,
    status: result.status,
    upsert: JSON.parse(result.stdout.slice(start)) as IUpsertShape,
  }
}

describe('update-deployment-logs add — provenance capture', () => {
  it(
    'records the branch, the actor and a dirty source file it was run from',
    () => {
      const { output, status, upsert } = runAdd({
        repoRoot: makeRepo({ branch: 'feature/exsc-695', dirty: true }),
      })

      expect(status).toBe(0)
      expect(upsert.update.$set).toMatchObject({
        gitBranch: 'feature/exsc-695',
        dirtyTreeScoped: [CONTRACT_PATH],
        dirtyTreeTruncated: false,
        actor: 'human',
      })
      // The signer-visible half: a reviewer reading the deploy output, not the
      // record, has to see the dirty tree too.
      expect(output).toContain('Deployed from a dirty tree')
      expect(output).toContain(CONTRACT_PATH)
    },
    CASE_TIMEOUT_MS
  )

  it(
    'records a clean tree as an empty list rather than omitting the field',
    () => {
      const { output, upsert } = runAdd({
        repoRoot: makeRepo({ branch: 'main', dirty: false }),
      })

      expect(upsert.update.$set).toMatchObject({
        gitBranch: 'main',
        dirtyTreeScoped: [],
        dirtyTreeTruncated: false,
      })
      expect(output).toContain('dirty no')
      expect(output).not.toContain('Deployed from a dirty tree')
    },
    CASE_TIMEOUT_MS
  )

  it(
    'reports CI as the actor and takes the branch from the workflow environment',
    () => {
      const repoRoot = makeRepo({ branch: 'feature/exsc-695', dirty: false })
      const detach = spawnSync('git', ['checkout', '--detach'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(detach.status).toBe(0)

      const previous = {
        actions: process.env.GITHUB_ACTIONS,
        ref: process.env.GITHUB_REF_NAME,
      }
      process.env.GITHUB_ACTIONS = 'true'
      process.env.GITHUB_REF_NAME = 'refs/pull/2331/merge'
      try {
        const { upsert } = runAdd({ repoRoot })

        expect(upsert.update.$set).toMatchObject({
          actor: 'ci',
          gitBranch: 'refs/pull/2331/merge',
        })
      } finally {
        if (previous.actions === undefined) delete process.env.GITHUB_ACTIONS
        else process.env.GITHUB_ACTIONS = previous.actions
        if (previous.ref === undefined) delete process.env.GITHUB_REF_NAME
        else process.env.GITHUB_REF_NAME = previous.ref
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    'never lets provenance into the identity the upsert matches on',
    () => {
      const { upsert } = runAdd({
        repoRoot: makeRepo({ branch: 'feature/exsc-695', dirty: true }),
      })

      expect(Object.keys(upsert.filter).sort()).toEqual([
        'address',
        'contractName',
        'network',
        'version',
      ])
      expect(upsert.filter.address).toEqual({ $eq: ADDRESS })
    },
    CASE_TIMEOUT_MS
  )

  it(
    'reports unknown provenance instead of a clean tree outside a git checkout',
    () => {
      // No `git init`: every probe fails, and the one answer that must never be
      // invented here is "the tree was clean".
      const { output, upsert } = runAdd({
        repoRoot: mkdtempSync(join(tmpdir(), 'deploy-log-no-git-')),
      })

      expect(upsert.update.$set).not.toHaveProperty('gitBranch')
      expect(upsert.update.$setOnInsert).toMatchObject({
        gitBranch: 'UNKNOWN',
      })
      expect(output).toContain('branch UNKNOWN')
    },
    CASE_TIMEOUT_MS
  )
})
