/**
 * Production deploy gate for `script/tasks/diamondUpdateFacet.sh`.
 *
 * Staging is always allowed. Production from `main` is always allowed. Production
 * from any other branch may proceed only when each selected facet matches `main`,
 * or — if it does not — when that branch has an open PR and the facet is frozen
 * at the commit recorded in `audit/auditLog.json`.
 *
 * A facet is compared through its transitive `src/` import closure, not just its own
 * file, because an edited library or helper changes the deployed bytecode while the
 * facet file still matches. The audit log is read from the `main` ref for the same
 * reason the facets are: a working-tree copy would let the deploy certify itself.
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
 * `src/` (submodules under `lib/` are pinned by their submodule commit)
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
 * Collects every reason a production deploy from a feature branch is not allowed.
 * Staging and `main` always pass. Pure, so the policy can be exercised without git or GitHub.
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
  if (input.branch === 'main') return []
  if (input.facets.length === 0) return ['No facets were passed to the check']

  const diverged = input.facets.filter((facet) => !facet.matchesMain)
  if (diverged.length === 0) return []

  const failures: string[] = []
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

const git = (
  args: string[],
  cwd: string
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

const resolveMainRef = (repoRoot: string): string => {
  if (git(['rev-parse', '--verify', 'origin/main'], repoRoot).status === 0)
    return 'origin/main'
  if (git(['rev-parse', '--verify', 'main'], repoRoot).status === 0)
    return 'main'

  throw new Error(
    'Cannot resolve main (tried origin/main and main). Fetch origin/main before deploying.'
  )
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
  getContractVersion: (name: string) => Promise<string>
  resolveAuditCommitHash: (name: string, version: string) => string | undefined
  getOpenPrCount: (branch: string) => Promise<number>
}

/**
 * Builds the real git / audit-log / GitHub lookups used by the CLI.
 * `mainRef`, the audit log, and GitHub are resolved lazily so staging/`main`
 * short-circuits never shell out.
 * @param repoRoot - repository root (working tree that will be compiled)
 * @returns the git / audit-log / GitHub lookups used by the CLI
 */
export const createDefaultDeps = (repoRoot: string): IDeployGateDeps => {
  let mainRef: string | undefined
  let auditLog: IAuditLogData | undefined
  const getMainRef = (): string => (mainRef ??= resolveMainRef(repoRoot))

  return {
    get mainRef() {
      return getMainRef()
    },
    fileMatchesRef: (ref, path) => fileMatchesRef(repoRoot, ref, path),
    refExists: (ref) =>
      git(['cat-file', '-e', `${ref}^{commit}`], repoRoot).status === 0,
    sourceClosure: (path) =>
      collectSourceClosure(path, (candidate) =>
        readWorkingCopy(repoRoot, candidate)
      ),
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
  if (input.branch === 'main') return []

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
  const hasOpenPr = diverged
    ? (await deps.getOpenPrCount(input.branch)) > 0
    : false

  return collectDeployGateFailures({
    environment: input.environment,
    branch: input.branch,
    facets: checks,
    hasOpenPr,
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
