/**
 * Git provenance capture
 *
 * Fail-soft answers to "which code produced this?" — HEAD commit, branch,
 * scoped working-tree dirtiness, whether that commit exists on a remote, who
 * ran the command, and the open PR for the branch. Import it from any script
 * that records audit metadata about its own run (Safe proposals today, deploy
 * logs next).
 *
 * Every helper swallows its own failures, returns a sentinel and appends a
 * one-line message to an error collector. Capture sits on the deployment path,
 * which aborts a deploy on any thrown error, so provenance must never be the
 * reason a deploy fails. The captured block is also self-reported context, not
 * a security control: it makes honest mistakes visible, it does not defend
 * against someone deliberately lying about their own run.
 */

import { spawnSync } from 'node:child_process'

/**
 * Sentinel for a value that could not be determined. Deliberately distinct from
 * `undefined`, which on a stored record means "written before provenance
 * capture existed" rather than "capture ran and failed".
 */
export const PROVENANCE_UNKNOWN = 'unknown'

/** Most dirty paths recorded; overflow is reported via a truncation flag. */
export const MAX_DIRTY_PATHS = 20

// 5 seconds: a hung git or gh must never stall a proposal or a deploy.
const GIT_TIMEOUT_MS = 5_000
const GH_TIMEOUT_MS = 5_000
// 8 MB: `status --porcelain` on a very dirty tree, well above any realistic run.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * Paths the deploy pipeline itself writes mid-run (`saveContract`,
 * `saveDiamondFacets`, `saveDiamondPeriphery`, `updateDiamondLogs`, the
 * target-state merge, and the untracked `deployments/*.lock` markers). They
 * turn a normal deploy's tree dirty while saying nothing about source drift.
 *
 * Governance inputs such as `config/whitelist.json` are deliberately NOT
 * excluded: a dirty whitelist at proposal time is exactly what a reviewer needs
 * to see. Most build output (`out/`, `cache/`, `broadcast/`, …) is gitignored
 * and never reaches this filter.
 */
const PROVENANCE_DIRTY_EXCLUDES: readonly RegExp[] = [
  /^deployments\//u,
  /^script\/deploy\/_targetState\.json$/u,
]

/**
 * Branches a PR lookup is pointless for: the trunk itself, a detached HEAD, and
 * the failure sentinel. Skipping them avoids spawning `gh` for no reason.
 */
const BRANCHES_WITHOUT_PR: ReadonlySet<string> = new Set([
  'main',
  'HEAD',
  PROVENANCE_UNKNOWN,
])

/** Execution context a captured artefact was produced in. */
export type ProvenanceActor = 'human' | 'bot' | 'ci' | 'unknown'

/** Outcome of one subprocess run. Never represents a thrown error. */
export interface ICommandResult {
  /** Exit code, or `null` when the process was killed or never started. */
  status: number | null
  stdout: string
  stderr: string
  /** Spawn-level failure (binary missing, timeout kill, bad arguments). */
  error?: Error
}

/** Runs a command synchronously and reports the outcome instead of throwing. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
) => ICommandResult

/** Optional overrides; production callers pass nothing. */
export interface IProvenanceContext {
  /** Directory git runs in. Defaults to the repo root, then `process.cwd()`. */
  cwd?: string
  /** Environment read for CI hints. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Test seam for the subprocess runner. Production leaves this unset. */
  run?: CommandRunner
  /**
   * Collector for non-fatal capture problems. Pass an array to receive them;
   * without one the messages are discarded rather than thrown or logged.
   */
  errors?: string[]
}

/** Options for a full provenance capture. */
export interface ICaptureProvenanceOptions extends IProvenanceContext {
  /**
   * Look the branch's open PR up via `gh`. Best effort and on by default; set
   * `false` to skip the subprocess entirely (offline runs, hot loops).
   */
  resolvePrUrl?: boolean
}

/** Scoped working-tree dirtiness at capture time. */
export interface IDirtyTree {
  /** Repo-relative dirty paths, sorted, deploy-generated artefacts removed. */
  paths: string[]
  /** True when more dirty paths existed than `paths` records. */
  truncated: boolean
}

/** Ambient git state describing the code a run was produced from. */
export interface IGitProvenance {
  /** Execution context: a human at a workstation, a bot, or CI. */
  actor: ProvenanceActor
  /** `"Name <email>"`, the CI actor login, or {@link PROVENANCE_UNKNOWN}. */
  proposerHandle: string
  /** Full 40-char HEAD SHA, or {@link PROVENANCE_UNKNOWN}. */
  gitCommit: string
  /** Branch name, `'HEAD'` when detached, or {@link PROVENANCE_UNKNOWN}. */
  gitBranch: string
  /** Dirty paths excluding deploy-generated artefacts. Empty = clean tree. */
  dirtyTreeScoped: string[]
  /** Present only when the dirty list was capped at {@link MAX_DIRTY_PATHS}. */
  dirtyTreeTruncated?: boolean
  /**
   * Whether `gitCommit` is reachable from a remote-tracking ref, i.e. whether a
   * reviewer can fetch the code that produced this run. Read from local refs
   * only (no network), so a stale checkout can report `false` for a commit that
   * is in fact pushed. Absent when the check could not run.
   */
  commitOnRemote?: boolean
  /** Open PR for `gitBranch`, when `gh` resolves one. */
  prUrl?: string
  /** Non-fatal capture problems, so a sentinel value is explainable. */
  captureErrors?: string[]
}

/** Result of a capture in which nothing at all could be determined. */
const UNKNOWN_GIT_PROVENANCE: IGitProvenance = {
  actor: PROVENANCE_UNKNOWN,
  proposerHandle: PROVENANCE_UNKNOWN,
  gitCommit: PROVENANCE_UNKNOWN,
  gitBranch: PROVENANCE_UNKNOWN,
  dirtyTreeScoped: [],
}

/**
 * Process-lifetime memo. The multi-network task scripts store one proposal per
 * network in a loop; without this, a 50-network run would spawn several hundred
 * git processes to re-derive state that cannot change mid-run.
 */
let cachedProvenance: IGitProvenance | undefined

/** Everything the internal helpers need, with defaults already applied. */
interface IResolvedContext {
  cwd: string
  env: NodeJS.ProcessEnv
  run: CommandRunner
  errors: string[]
}

const defaultRunner: CommandRunner = (command, args, options) => {
  try {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER_BYTES,
      ...(options.env ? { env: options.env } : {}),
    })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error } : {}),
    }
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

function describeFailure(result: ICommandResult): string {
  if (result.error) return result.error.message
  const stderr = result.stderr.trim()
  if (stderr.length > 0) return stderr
  return `exit ${result.status}`
}

/**
 * Runs a command and returns its stdout, or `null` on any failure.
 * `quiet` suppresses the error record for probes whose failure is a normal
 * state rather than an anomaly (an unset git identity, a missing `gh`).
 * `preserveIndent` keeps leading whitespace, which is load-bearing in
 * column-oriented output such as `status --porcelain`.
 */
function runCommand(
  command: string,
  args: readonly string[],
  ctx: IResolvedContext,
  options: {
    timeoutMs: number
    quiet?: boolean
    preserveIndent?: boolean
    env?: NodeJS.ProcessEnv
  }
): string | null {
  const result = ctx.run(command, args, {
    cwd: ctx.cwd,
    timeoutMs: options.timeoutMs,
    ...(options.env ? { env: options.env } : {}),
  })
  if (result.error || result.status !== 0) {
    if (!options.quiet)
      ctx.errors.push(
        `${command} ${args.join(' ')} failed: ${describeFailure(result)}`
      )
    return null
  }
  return options.preserveIndent
    ? result.stdout.replace(/\s+$/u, '')
    : result.stdout.trim()
}

function runGit(
  args: readonly string[],
  ctx: IResolvedContext,
  options: { quiet?: boolean; preserveIndent?: boolean } = {}
): string | null {
  return runCommand('git', args, ctx, {
    timeoutMs: GIT_TIMEOUT_MS,
    ...options,
  })
}

function findRepoRoot(
  run: CommandRunner,
  errors: string[],
  env: NodeJS.ProcessEnv
): string {
  // Task and Tron scripts are sometimes invoked from a subdirectory, so the
  // repo-relative paths in `git status` only line up against the toplevel.
  const start = process.cwd()
  const bootstrap: IResolvedContext = { cwd: start, env, run, errors }
  return runGit(['rev-parse', '--show-toplevel'], bootstrap) || start
}

function resolveContext(context?: IProvenanceContext): IResolvedContext {
  const run = context?.run ?? defaultRunner
  const env = context?.env ?? process.env
  const errors = context?.errors ?? []
  return {
    run,
    env,
    errors,
    cwd: context?.cwd ?? findRepoRoot(run, errors, env),
  }
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === 'true' || env.CI === 'true' || env.CI === '1'
}

function gitCommit(ctx: IResolvedContext): string {
  // A GitHub Actions checkout is detached and often shallow, so the workflow's
  // own SHA is more trustworthy there than anything HEAD reports.
  if (isCi(ctx.env) && ctx.env.GITHUB_SHA) return ctx.env.GITHUB_SHA
  return runGit(['rev-parse', 'HEAD'], ctx) || PROVENANCE_UNKNOWN
}

function gitBranch(ctx: IResolvedContext): string {
  if (isCi(ctx.env)) {
    // On a pull_request event HEAD is detached, so only these carry the branch.
    const ciBranch = ctx.env.GITHUB_HEAD_REF || ctx.env.GITHUB_REF_NAME
    if (ciBranch) return ciBranch
  }
  return (
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], ctx) || PROVENANCE_UNKNOWN
  )
}

/** Strips git's C-style quoting from a path containing special characters. */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  return raw.slice(1, -1).replace(/\\(.)/gu, '$1')
}

function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = []
  for (const line of porcelain.split('\n')) {
    // Porcelain v1 lines are `XY<space><path>`; anything shorter is not an entry.
    if (line.length <= 3) continue
    const entry = line.slice(3)
    // A rename reads `old -> new`; only the destination exists on disk now.
    const arrow = entry.lastIndexOf(' -> ')
    const path = unquotePath(
      (arrow === -1 ? entry : entry.slice(arrow + 4)).trim()
    )
    if (path.length > 0) paths.push(path)
  }
  return paths
}

function scopedDirtyTree(ctx: IResolvedContext): IDirtyTree {
  // preserveIndent: an unstaged change reports a leading space in the status
  // column (` M path`), and trimming it would shift every path one character
  // and silently drop the first letter of the first entry.
  const porcelain = runGit(
    ['status', '--porcelain', '--untracked-files=normal'],
    ctx,
    { preserveIndent: true }
  )
  // `null` means the probe failed, which is not the same as a clean tree — the
  // recorded error is what tells a reader the empty list is not a clean bill.
  if (porcelain === null) return { paths: [], truncated: false }

  const relevant = parsePorcelainPaths(porcelain).filter(
    (path) => !PROVENANCE_DIRTY_EXCLUDES.some((pattern) => pattern.test(path))
  )
  const unique = [...new Set(relevant)].sort()
  return {
    paths: unique.slice(0, MAX_DIRTY_PATHS),
    truncated: unique.length > MAX_DIRTY_PATHS,
  }
}

function commitOnRemote(
  commit: string,
  ctx: IResolvedContext
): boolean | undefined {
  if (commit === PROVENANCE_UNKNOWN) return undefined
  const containing = runGit(['branch', '--remotes', '--contains', commit], ctx)
  if (containing === null) return undefined
  return containing.length > 0
}

function gitIdentity(ctx: IResolvedContext): string | undefined {
  // Quiet: an unset identity is a normal state on a CI runner, not an anomaly.
  const name = runGit(['config', 'user.name'], ctx, { quiet: true })
  const email = runGit(['config', 'user.email'], ctx, { quiet: true })
  if (name && email) return `${name} <${email}>`
  return name || email || undefined
}

function proposerHandle(
  ctx: IResolvedContext,
  identity: string | undefined
): string {
  if (isCi(ctx.env) && ctx.env.GITHUB_ACTOR) return ctx.env.GITHUB_ACTOR
  return identity ?? PROVENANCE_UNKNOWN
}

function openPrUrl(branch: string, ctx: IResolvedContext): string | undefined {
  if (BRANCHES_WITHOUT_PR.has(branch)) return undefined
  // Quiet and short-timeout: `gh` is frequently absent or unauthenticated on a
  // deployer's machine, and that must stay invisible rather than look like a
  // capture failure on every single proposal.
  const url = runCommand(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--limit',
      '1',
      '--json',
      'url',
      '--jq',
      '.[0].url',
    ],
    ctx,
    {
      timeoutMs: GH_TIMEOUT_MS,
      quiet: true,
      env: {
        ...ctx.env,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
      },
    }
  )
  return url && url.startsWith('https://') ? url : undefined
}

function cloneGitProvenance(provenance: IGitProvenance): IGitProvenance {
  return {
    ...provenance,
    dirtyTreeScoped: [...provenance.dirtyTreeScoped],
    ...(provenance.captureErrors
      ? { captureErrors: [...provenance.captureErrors] }
      : {}),
  }
}

/**
 * Classifies the execution context. Pure: reads the given environment only, so
 * the CI and bot branches are exercisable without a runner.
 * @param env - Environment to inspect.
 * @param hasGitIdentity - Whether a local git identity resolved.
 * @returns The detected actor; `'unknown'` when nothing identifies the caller.
 */
export function detectActor(
  env: NodeJS.ProcessEnv,
  hasGitIdentity: boolean
): ProvenanceActor {
  if (isCi(env)) return 'ci'
  // Explicit opt-in an unattended job sets so its proposals are not filed under
  // whichever git identity happens to be configured on the host.
  if (env.SAFE_PROPOSAL_ACTOR === 'bot') return 'bot'
  return hasGitIdentity ? 'human' : PROVENANCE_UNKNOWN
}

/**
 * Reads the HEAD commit.
 * @param context - Optional overrides (cwd, env, runner, error collector).
 * @returns The 40-char SHA, or {@link PROVENANCE_UNKNOWN} on failure.
 */
export function getGitCommit(context?: IProvenanceContext): string {
  return gitCommit(resolveContext(context))
}

/**
 * Reads the checked-out branch.
 * @param context - Optional overrides (cwd, env, runner, error collector).
 * @returns The branch name, `'HEAD'` when detached, or {@link PROVENANCE_UNKNOWN}.
 */
export function getGitBranch(context?: IProvenanceContext): string {
  return gitBranch(resolveContext(context))
}

/**
 * Lists dirty working-tree paths, excluding artefacts the deploy pipeline
 * rewrites during its own run.
 * @param context - Optional overrides (cwd, env, runner, error collector).
 * @returns Capped, sorted paths plus a truncation flag. An empty list with a
 * recorded error means the probe failed, not that the tree is clean.
 */
export function getScopedDirtyTree(context?: IProvenanceContext): IDirtyTree {
  return scopedDirtyTree(resolveContext(context))
}

/**
 * Checks whether a commit is reachable from any remote-tracking ref, i.e.
 * whether a reviewer could fetch it. Local refs only — no network call.
 * @param commit - Commit SHA to look for.
 * @param context - Optional overrides (cwd, env, runner, error collector).
 * @returns `true`/`false`, or `undefined` when the check could not run.
 */
export function isCommitOnRemote(
  commit: string,
  context?: IProvenanceContext
): boolean | undefined {
  return commitOnRemote(commit, resolveContext(context))
}

/**
 * Resolves who is running: the CI actor login, else the local git identity.
 * @param context - Optional overrides (cwd, env, runner, error collector).
 * @returns `"Name <email>"`, a CI login, or {@link PROVENANCE_UNKNOWN}.
 */
export function getProposerHandle(context?: IProvenanceContext): string {
  const ctx = resolveContext(context)
  return proposerHandle(ctx, gitIdentity(ctx))
}

/**
 * Best-effort lookup of the open PR for a branch via `gh`.
 * @param branch - Branch to look up; trunk/detached/unknown are skipped.
 * @param context - Optional overrides (cwd, env, runner, error collector).
 * @returns The PR URL, or `undefined` when `gh` is missing, unauthenticated,
 * slow, or has no open PR for the branch. Never records a capture error.
 */
export function resolveOpenPrUrl(
  branch: string,
  context?: IProvenanceContext
): string | undefined {
  return openPrUrl(branch, resolveContext(context))
}

/**
 * Clears the process-lifetime memo. Only tests need this — git state cannot
 * meaningfully change within one script run.
 */
export function resetGitProvenanceCache(): void {
  cachedProvenance = undefined
}

/**
 * Captures the full ambient git state in one pass.
 *
 * Memoized for the process lifetime, so the multi-network loops pay for the
 * subprocesses once rather than once per network. Never throws: an outer
 * backstop converts any unexpected failure into all-sentinel values with the
 * cause recorded in `captureErrors`.
 * @param options - Optional overrides plus `resolvePrUrl` (default `true`).
 * @returns A populated block; every field degrades to a sentinel on failure.
 */
export function captureGitProvenance(
  options?: ICaptureProvenanceOptions
): IGitProvenance {
  if (cachedProvenance) return cloneGitProvenance(cachedProvenance)

  const errors = options?.errors ?? []
  let captured: IGitProvenance
  try {
    const ctx = resolveContext({ ...options, errors })
    const identity = gitIdentity(ctx)
    const commit = gitCommit(ctx)
    const branch = gitBranch(ctx)
    const dirty = scopedDirtyTree(ctx)
    const onRemote = commitOnRemote(commit, ctx)
    const prUrl =
      options?.resolvePrUrl === false ? undefined : openPrUrl(branch, ctx)

    captured = {
      actor: detectActor(ctx.env, identity !== undefined),
      proposerHandle: proposerHandle(ctx, identity),
      gitCommit: commit,
      gitBranch: branch,
      dirtyTreeScoped: dirty.paths,
      ...(dirty.truncated ? { dirtyTreeTruncated: true } : {}),
      ...(onRemote === undefined ? {} : { commitOnRemote: onRemote }),
      ...(prUrl ? { prUrl } : {}),
      ...(errors.length > 0 ? { captureErrors: [...errors] } : {}),
    }
  } catch (error) {
    captured = {
      ...UNKNOWN_GIT_PROVENANCE,
      captureErrors: [
        ...errors,
        `provenance capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    }
  }

  cachedProvenance = captured
  return cloneGitProvenance(captured)
}
