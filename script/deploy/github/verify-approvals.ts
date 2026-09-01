/**
 * Production deploy gate for `script/tasks/diamondUpdateFacet.sh`.
 *
 * Staging is always allowed. A production deploy may proceed only when each selected
 * facet matches `main`, or — if it does not — when the branch has an open PR and the
 * facet is frozen at the commit recorded in `audit/auditLog.json`. What is compared is
 * the working tree, never the branch name: a checkout sitting on `main` earns nothing,
 * because uncommitted or stale content there is exactly what this gate exists to stop.
 *
 * A facet is compared through its transitive `src/` import closure, not just its own
 * file, because an edited library or helper changes the deployed bytecode while the
 * facet file still matches. Dependencies under `lib/` are compared by submodule gitlink,
 * since their content is not in this repo's tree. The audit log is read from the `main`
 * ref for the same reason the facets are: a working-tree copy would let the deploy
 * certify itself. `origin/main` is refreshed before any of this, so a never-fetched
 * checkout cannot pass by comparing against a stale main.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { EnvironmentEnum } from '../../common/types'
import { getContractVersion } from '../shared/getContractVersion'

const OWNER = 'lifinance'
const REPO = 'contracts'
const PR_LIST_LIMIT = 100 // well above the number of open PRs a single branch can have
const AUDIT_COMMIT_RE = /^[0-9a-f]{40}$/i
const AUDIT_LOG_PATH = 'audit/auditLog.json'
const MAIN_BRANCH = 'main'
const MAIN_REF = 'origin/main'
const REMOTE = 'origin'
const SOURCE_ROOT = 'src/'
const SOURCE_REMAPPING = 'lifi/' // remappings.txt maps this onto SOURCE_ROOT
const IMPORT_RE = /import\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/g
const PATHS_IN_MESSAGE = 5 // keep a wide closure readable in the deploy log

/** One selected facet after comparing it to `main` and, if needed, to its audit. */
export interface IFacetDeployCheck {
  name: string
  matchesMain: boolean
  version?: string
  auditCommitHash?: string
  auditCommitAvailable?: boolean
  matchesAuditedCommit?: boolean
  divergedFromMain?: string[]
  changedSinceAudit?: string[]
}

/** Inputs the production deploy policy is evaluated against. */
export interface IDeployGateInput {
  environment: string
  branch: string
  facets: IFacetDeployCheck[]
  hasOpenPr: boolean
  divergedSubmodules?: string[]
}

/** Audit log shape used to resolve a contract version to an audited commit. */
export interface IAuditLogData {
  audits: Record<string, { auditCommitHash?: string }>
  auditedContracts: Record<string, Record<string, string[]> | undefined>
}

/**
 * Splits the newline-separated `--facets` value into facet names.
 * @param raw - raw CLI value (the shell caller may append blank or trailing lines)
 * @returns trimmed facet names with empty entries removed
 */
export const parseFacetList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split('\n')
    .map((facet) => facet.trim())
    .filter((facet) => facet.length > 0)

const describePaths = (paths: string[] | undefined): string => {
  if (!paths?.length) return 'no file recorded'
  if (paths.length <= PATHS_IN_MESSAGE) return paths.join(', ')

  return `${paths.slice(0, PATHS_IN_MESSAGE).join(', ')} and ${
    paths.length - PATHS_IN_MESSAGE
  } more`
}

/**
 * Resolves a Solidity import to a repo-relative path inside `src/`.
 * @param fromPath - repo-relative path of the file holding the import
 * @param spec - the quoted import specifier
 * @returns the imported repo-relative path, or `undefined` when it lands outside
 * `src/`. Dependencies under `lib/` are outside the closure because their content is
 * not in this repo's tree; {@link divergedSubmodules} compares them by gitlink instead.
 */
export const resolveSolidityImport = (
  fromPath: string,
  spec: string
): string | undefined => {
  let resolved: string | undefined

  if (spec.startsWith('.'))
    resolved = posix.normalize(posix.join(posix.dirname(fromPath), spec))
  else if (spec.startsWith(SOURCE_REMAPPING))
    resolved = posix.normalize(
      SOURCE_ROOT + spec.slice(SOURCE_REMAPPING.length)
    )

  return resolved?.startsWith(SOURCE_ROOT) ? resolved : undefined
}

/**
 * Walks the transitive `src/` import closure of a Solidity file. Everything in the
 * closure is compiled into the facet, so all of it has to be compared, not just the
 * facet's own file.
 * @param entryPath - repo-relative path of the facet source
 * @param readSource - reads a repo-relative path, `undefined` when it does not exist
 * @returns sorted repo-relative paths, always including `entryPath`
 */
export const collectSourceClosure = (
  entryPath: string,
  readSource: (path: string) => string | undefined
): string[] => {
  const closure = new Set<string>([entryPath])
  const visited = new Set<string>()
  const queue = [entryPath]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)

    const source = readSource(current)
    if (source === undefined) continue

    for (const match of source.matchAll(IMPORT_RE)) {
      const imported = resolveSolidityImport(current, match[1] ?? '')
      // a specifier with no file behind it is never compiled in, so treating it as
      // part of the closure would block the deploy on a commented-out import
      if (imported === undefined || readSource(imported) === undefined) continue

      closure.add(imported)
      queue.push(imported)
    }
  }

  return [...closure].sort()
}

/**
 * Collects every reason a production deploy is not allowed. Staging always passes;
 * everything else is judged on what the working tree contains, never on the branch
 * name. Pure, so the policy can be exercised without git or GitHub.
 * @param input - environment, branch, and per-facet comparison results
 * @returns one message per violation; an empty array means the deploy may proceed
 */
export const collectDeployGateFailures = (
  input: IDeployGateInput
): string[] => {
  if (input.environment === EnvironmentEnum.staging) return []
  if (input.environment !== EnvironmentEnum.production)
    return [
      `Unknown environment "${input.environment}" (expected ${EnvironmentEnum.production} or ${EnvironmentEnum.staging})`,
    ]
  if (input.facets.length === 0) return ['No facets were passed to the check']

  // dependencies under lib/ are compiled into every facet, so a divergence there is
  // not excused by an open PR or an audit freeze the way a facet source is
  const submoduleFailures = input.divergedSubmodules?.length
    ? [
        `Dependencies under lib/ differ from ${MAIN_REF} (${describePaths(
          input.divergedSubmodules
        )}). They are compiled into the facet, so restore them with git submodule update --init --recursive (or drop local edits inside them) before deploying`,
      ]
    : []

  const diverged = input.facets.filter((facet) => !facet.matchesMain)
  if (diverged.length === 0) return submoduleFailures

  // no pull request can have `main` as its head, so neither the open-PR exception nor
  // the audit freeze behind it can apply: report the divergence and stop, rather than
  // sending the operator after an audit-log problem that does not exist
  if (input.branch === MAIN_BRANCH)
    return [
      ...submoduleFailures,
      `Deploying from "${MAIN_BRANCH}", but the working tree does not match ${MAIN_REF}. Move the change onto a branch and open a PR, or discard it (git checkout / git clean) and pull, before deploying`,
      ...diverged.map(
        (facet) =>
          `${facet.name} diverges from ${MAIN_REF} (${describePaths(
            facet.divergedFromMain
          )})`
      ),
    ]

  const failures: string[] = [...submoduleFailures]
  if (!input.hasOpenPr)
    failures.push(`No open PR found for branch "${input.branch}"`)

  for (const facet of diverged) {
    if (!facet.auditCommitHash) {
      failures.push(
        `${facet.name} (v${
          facet.version ?? 'unknown'
        }) diverges from main (${describePaths(
          facet.divergedFromMain
        )}) and has no audit log entry with a commit hash in ${AUDIT_LOG_PATH} on main`
      )
      continue
    }

    if (facet.auditCommitAvailable === false) {
      failures.push(
        `${facet.name} audited commit ${facet.auditCommitHash} is not present in this checkout - fetch it before deploying`
      )
      continue
    }

    if (!facet.matchesAuditedCommit)
      failures.push(
        `${facet.name} has changed since audited commit ${
          facet.auditCommitHash
        } (${describePaths(facet.changedSinceAudit)})`
      )
  }

  return failures
}

/**
 * Picks the latest usable 40-character audit commit hash for a contract version.
 * @param log - parsed `audit/auditLog.json`
 * @param contractName - Solidity contract name (filename without `.sol`)
 * @param version - `@custom:version` value from the working-tree source
 * @returns the hash, or `undefined` when none is recorded / all entries are `n/a`
 */
export const resolveAuditCommitHash = (
  log: IAuditLogData,
  contractName: string,
  version: string
): string | undefined => {
  const auditIds = log.auditedContracts[contractName]?.[version] ?? []

  for (let index = auditIds.length - 1; index >= 0; index--) {
    const hash = log.audits[auditIds[index] ?? '']?.auditCommitHash?.trim()
    if (hash && AUDIT_COMMIT_RE.test(hash)) return hash
  }

  return undefined
}

const facetSourcePath = (name: string): string => `src/Facets/${name}.sol`

const NETWORK_TIMEOUT_MS = 30_000
const SSH_CONNECT_TIMEOUT_S = 10

/**
 * Runs git with prompts disabled, so a missing credential or an unknown host key
 * fails instead of blocking on a terminal the deploy may not even have.
 * @param args - git arguments
 * @param cwd - working directory
 * @param timeoutMs - kill the process after this long; used for the network calls,
 * which would otherwise hang indefinitely against a remote that accepts and stalls
 * @returns exit status and captured output; a timeout surfaces as a non-zero status
 */
const git = (
  args: string[],
  cwd: string,
  timeoutMs?: number
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: `${
        process.env.GIT_SSH_COMMAND ?? 'ssh'
      } -o BatchMode=yes -o ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    },
  })

  return {
    // a timeout leaves status null, which must not read as success
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

/**
 * Resolves the remote-tracking ref every comparison is made against, refreshing it
 * first so "matches main" cannot mean "matches a main from last week".
 *
 * Only `origin/main` qualifies: local `main` is whatever the operator last committed,
 * so accepting it would let a local commit satisfy the gate that exists to require a
 * merged one. The remote tip is read with `ls-remote` and only fetched when it differs,
 * so the common case costs one round trip and transfers no objects. An unreachable
 * remote fails the gate rather than falling back to the local copy — the whole point is
 * that this comparison is against the authoritative main.
 * @param repoRoot - repository root
 * @returns the remote-tracking ref for main
 * @throws If `origin/main` cannot be resolved, reached, or updated
 */
const resolveMainRef = (repoRoot: string): string => {
  if (git(['rev-parse', '--verify', MAIN_REF], repoRoot).status !== 0)
    throw new Error(
      `Cannot resolve ${MAIN_REF} in this checkout. Fetch it before deploying.`
    )

  const remote = git(
    ['ls-remote', REMOTE, MAIN_BRANCH],
    repoRoot,
    NETWORK_TIMEOUT_MS
  )
  if (remote.status !== 0)
    throw new Error(
      `Cannot reach ${REMOTE} to check whether ${MAIN_REF} is current. The gate compares against the merged main, so it cannot run offline.\n${remote.stderr.trim()}`
    )

  // ls-remote also echoes any matching remote-tracking ref, so match refs/heads exactly
  const remoteSha = remote.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, ref]) => ref === `refs/heads/${MAIN_BRANCH}`)?.[0]

  if (remoteSha === undefined)
    throw new Error(`${REMOTE} has no ${MAIN_BRANCH} branch`)

  const localSha = git(['rev-parse', MAIN_REF], repoRoot).stdout.trim()
  if (remoteSha === localSha) return MAIN_REF

  consola.info(`${MAIN_REF} is behind ${REMOTE}, fetching before comparing`)
  const fetch = git(
    ['fetch', '--quiet', REMOTE, MAIN_BRANCH],
    repoRoot,
    NETWORK_TIMEOUT_MS
  )
  if (fetch.status !== 0)
    throw new Error(
      `Failed to fetch ${MAIN_BRANCH} from ${REMOTE}.\n${fetch.stderr.trim()}`
    )

  // `git fetch <remote> <branch>` updates the remote-tracking ref only through the
  // configured refspec, so under a narrow refspec it can exit 0 having moved nothing
  // but FETCH_HEAD - which would leave the comparison on the stale ref it just refused
  if (git(['rev-parse', MAIN_REF], repoRoot).stdout.trim() !== remoteSha)
    throw new Error(
      `Fetched ${MAIN_BRANCH} from ${REMOTE}, but ${MAIN_REF} still does not point at ${remoteSha}. Check this checkout's fetch refspec.`
    )

  return MAIN_REF
}

/**
 * Lists the paths under `lib/` whose state differs from `ref`.
 *
 * Dependencies there are compiled into the facet but live in submodules, so their
 * content is not in the superproject tree and cannot be compared file by file. The
 * gitlink can be: `--ignore-submodules=untracked` reports a submodule whose HEAD differs
 * from the recorded commit *or* whose tracked files are modified, and it is passed
 * explicitly so a repo-level or user-level `ignore` setting cannot weaken the check.
 * `untracked` rather than `none` because a stray untracked file changes no bytecode -
 * and most of these submodules do not gitignore `.DS_Store`, so `none` would block
 * every deploy after one Finder visit.
 * @param repoRoot - repository root
 * @param ref - git ref to compare against
 * @returns repo-relative submodule paths that differ
 * @throws If the comparison cannot be performed
 */
export const divergedSubmodules = (repoRoot: string, ref: string): string[] => {
  const result = git(
    ['diff', '--name-only', '--ignore-submodules=untracked', ref, '--', 'lib/'],
    repoRoot
  )

  if (result.status !== 0)
    throw new Error(
      `Cannot compare lib/ against ${ref}.\n${result.stderr.trim()}`
    )

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const readWorkingCopy = (
  repoRoot: string,
  relativePath: string
): string | undefined => {
  try {
    return readFileSync(join(repoRoot, relativePath), 'utf8')
  } catch {
    return undefined
  }
}

const readAtRef = (
  repoRoot: string,
  ref: string,
  relativePath: string
): string | undefined => {
  const result = git(['show', `${ref}:${relativePath}`], repoRoot)
  if (result.status !== 0) return undefined
  return result.stdout
}

const fileMatchesRef = (
  repoRoot: string,
  ref: string,
  relativePath: string
): boolean => {
  const working = readWorkingCopy(repoRoot, relativePath)
  const atRef = readAtRef(repoRoot, ref, relativePath)
  if (working === undefined || atRef === undefined) return false
  return working === atRef
}

/**
 * Reads the audit log from a git ref. Sourcing it from the working tree would let a
 * deploy certify itself: a fabricated entry pointing at any local commit would
 * satisfy the divergence exception without the audit ever having been merged.
 * @param repoRoot - repository root
 * @param ref - git ref to read the audit log from
 * @returns the parsed audit log
 * @throws If the ref does not carry an audit log
 */
const loadAuditLog = (repoRoot: string, ref: string): IAuditLogData => {
  const contents = readAtRef(repoRoot, ref, AUDIT_LOG_PATH)
  if (contents === undefined)
    throw new Error(
      `Cannot read ${AUDIT_LOG_PATH} at ${ref}. Fetch ${ref} before deploying.`
    )

  return JSON.parse(contents) as IAuditLogData
}

/**
 * Counts the open pull requests whose head is the given branch.
 * Uses the GitHub CLI so the deploy needs no personal access token of its own.
 * @param branch - branch name to match
 * @returns the number of matching open pull requests
 * @throws If the GitHub CLI is missing, unauthenticated, or returns unusable output
 */
const countOpenPRsForBranch = (branch: string): number => {
  let stdout: string
  try {
    stdout = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        `${OWNER}/${REPO}`,
        '--head',
        branch,
        '--state',
        'open',
        '--limit',
        String(PR_LIST_LIMIT),
        '--json',
        'headRefName',
      ],
      { encoding: 'utf8', timeout: 60_000 }
    )
  } catch (error) {
    throw new Error(
      `Could not list open pull requests for branch "${branch}" through the GitHub CLI. ` +
        'Check that gh is installed and authenticated ("gh auth status"). ' +
        `Underlying error: ${
          error instanceof Error ? error.message : String(error)
        }`
    )
  }

  const pullRequests = JSON.parse(stdout) as { headRefName: string }[]
  return pullRequests.filter(
    (pullRequest) => pullRequest.headRefName === branch
  ).length
}

/** Git / audit-log / GitHub lookups the orchestrator needs. Injectable in tests. */
export interface IDeployGateDeps {
  mainRef: string
  fileMatchesRef: (ref: string, path: string) => boolean
  refExists: (ref: string) => boolean
  sourceClosure: (path: string) => string[]
  divergedSubmodules: () => string[]
  getContractVersion: (name: string) => Promise<string>
  resolveAuditCommitHash: (name: string, version: string) => string | undefined
  getOpenPrCount: (branch: string) => Promise<number>
}

/**
 * Builds the real git / audit-log / GitHub lookups used by the CLI.
 * `mainRef`, the audit log, and GitHub are resolved lazily so the staging
 * short-circuit never shells out, and a tree that matches `main` never reaches GitHub.
 * @param repoRoot - repository root (working tree that will be compiled)
 * @returns the git / audit-log / GitHub lookups used by the CLI
 */
export const createDefaultDeps = (repoRoot: string): IDeployGateDeps => {
  let mainRef: string | undefined
  let auditLog: IAuditLogData | undefined
  const getMainRef = (): string => (mainRef ??= resolveMainRef(repoRoot))

  // one facet's closure overlaps heavily with the next one's, so a fleet rollout would
  // otherwise re-read the same shared libraries once per facet
  const matchCache = new Map<string, boolean>()
  const closureCache = new Map<string, string[]>()
  const sourceCache = new Map<string, string | undefined>()
  const readSource = (path: string): string | undefined => {
    if (!sourceCache.has(path))
      sourceCache.set(path, readWorkingCopy(repoRoot, path))
    return sourceCache.get(path)
  }

  return {
    get mainRef() {
      return getMainRef()
    },
    fileMatchesRef: (ref, path) => {
      const key = `${ref}\0${path}`
      let match = matchCache.get(key)
      if (match === undefined) {
        match = fileMatchesRef(repoRoot, ref, path)
        matchCache.set(key, match)
      }
      return match
    },
    refExists: (ref) =>
      git(['cat-file', '-e', `${ref}^{commit}`], repoRoot).status === 0,
    sourceClosure: (path) => {
      let closure = closureCache.get(path)
      if (closure === undefined) {
        closure = collectSourceClosure(path, readSource)
        closureCache.set(path, closure)
      }
      return closure
    },
    divergedSubmodules: () => divergedSubmodules(repoRoot, getMainRef()),
    getContractVersion,
    resolveAuditCommitHash: (name, version) => {
      auditLog ??= loadAuditLog(repoRoot, getMainRef())
      return resolveAuditCommitHash(auditLog, name, version)
    },
    getOpenPrCount: async (branch) => countOpenPRsForBranch(branch),
  }
}

/**
 * Compares each selected facet's import closure to `main` (and, if it differs, to
 * its audited commit) and evaluates the production deploy policy.
 * @param input - environment, branch, and facet names about to be proposed
 * @param deps - git / audit-log / GitHub lookups
 * @returns one message per violation; empty when the deploy may proceed
 */
export const verifyDeployGate = async (
  input: {
    environment: string
    branch: string
    facets: string[]
  },
  deps: IDeployGateDeps
): Promise<string[]> => {
  if (input.environment === EnvironmentEnum.staging) return []
  if (input.environment !== EnvironmentEnum.production)
    return collectDeployGateFailures({ ...input, facets: [], hasOpenPr: false })

  const submodules = deps.divergedSubmodules()

  const checks: IFacetDeployCheck[] = []
  for (const name of input.facets) {
    const closure = deps.sourceClosure(facetSourcePath(name))
    const divergedFromMain = closure.filter(
      (path) => !deps.fileMatchesRef(deps.mainRef, path)
    )
    if (divergedFromMain.length === 0) {
      checks.push({ name, matchesMain: true })
      continue
    }

    const version = await deps.getContractVersion(name)
    const auditCommitHash = deps.resolveAuditCommitHash(name, version)
    if (auditCommitHash === undefined) {
      checks.push({ name, matchesMain: false, version, divergedFromMain })
      continue
    }

    const auditCommitAvailable = deps.refExists(auditCommitHash)
    const changedSinceAudit = auditCommitAvailable
      ? closure.filter((path) => !deps.fileMatchesRef(auditCommitHash, path))
      : closure

    checks.push({
      name,
      matchesMain: false,
      version,
      auditCommitHash,
      auditCommitAvailable,
      matchesAuditedCommit:
        auditCommitAvailable && changedSinceAudit.length === 0,
      divergedFromMain,
      changedSinceAudit,
    })
  }

  const diverged = checks.some((check) => !check.matchesMain)
  const hasOpenPr =
    diverged && input.branch !== MAIN_BRANCH
      ? (await deps.getOpenPrCount(input.branch)) > 0
      : false

  return collectDeployGateFailures({
    environment: input.environment,
    branch: input.branch,
    facets: checks,
    hasOpenPr,
    divergedSubmodules: submodules,
  })
}

/** The process surface `reportApprovalResult` terminates and prints through. */
export interface IReportTarget {
  stdout: { write: (text: string) => unknown }
  exit: (code: number) => never
}

/**
 * Applies the contract the shell gate relies on: failures go to stderr and terminate
 * the process non-zero, and the success marker reaches stdout only when there is
 * nothing to report.
 * @param failures - violations returned by the deploy gate
 * @param target - process to print through and terminate; injectable so the exit-code
 * contract can be unit-tested
 */
export const reportApprovalResult = (
  failures: string[],
  target: IReportTarget = process
): void => {
  if (failures.length === 0) {
    target.stdout.write('OK\n')
    return
  }

  for (const failure of failures) consola.error(failure)
  consola.error(
    `Production deploy gate failed (${failures.length} issue(s)) - not proceeding`
  )

  target.exit(1)
}

const main = defineCommand({
  meta: {
    name: 'verify-approvals',
    description:
      'Gates production Safe upgrade proposals on main-equivalence or an audited freeze',
  },
  args: {
    environment: {
      type: 'string',
      description: 'Deployment environment (production | staging)',
      required: true,
    },
    branch: {
      type: 'string',
      description: 'The current branch',
      required: true,
    },
    facets: {
      type: 'string',
      description: 'List of facets about to be proposed',
      required: true,
    },
  },
  async run({ args }) {
    const failures = await verifyDeployGate(
      {
        environment: args.environment,
        branch: args.branch,
        facets: parseFacetList(args.facets),
      },
      createDefaultDeps(process.cwd())
    )

    reportApprovalResult(failures)
  },
})

if (import.meta.main) runMain(main)
