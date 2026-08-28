/**
 * Production deploy gate for `script/deploy/deployUpgradesToSAFE.sh`.
 *
 * Staging is always allowed. Production from `main` is always allowed. Production
 * from any other branch may proceed only when each selected facet matches `main`,
 * or — if it does not — when that branch has an open PR and the facet is frozen
 * at the commit recorded in `audit/auditLog.json`.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Octokit } from '@octokit/rest'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { EnvironmentEnum } from '../../common/types'
import { getContractVersion } from '../shared/getContractVersion'

const OWNER = 'lifinance'
const REPO = 'contracts'
const PER_PAGE = 100 // GitHub's maximum page size, so paginated calls need the fewest requests
const AUDIT_COMMIT_RE = /^[0-9a-f]{40}$/i
const AUDIT_LOG_PATH = 'audit/auditLog.json'

/** One selected facet after comparing it to `main` and, if needed, to its audit. */
export interface IFacetDeployCheck {
  name: string
  matchesMain: boolean
  version?: string
  auditCommitHash?: string
  matchesAuditedCommit?: boolean
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

/**
 * Resolves the GitHub token used to look up an open PR on the exception path.
 * @param cliToken - value passed via `--token`; empty when the caller has none configured
 * @returns the resolved, non-empty token
 * @throws If neither the CLI argument nor the environment provides a token
 */
export const resolveGithubToken = (cliToken: string | undefined): string => {
  const token = cliToken?.trim() || process.env.GH_TOKEN?.trim()

  if (!token)
    throw new Error(
      'No GitHub token available: pass --token or set GH_TOKEN in your .env (see .env.example). ' +
        'lifinance/contracts is public, so a classic PAT needs no scopes beyond public_repo to ' +
        'read the open pull request for the branch. A token is only required for production ' +
        'deploys from a feature branch whose selected facet sources differ from main.'
    )

  return token
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
        }) has no audit log entry with a commit hash`
      )
      continue
    }

    if (!facet.matchesAuditedCommit)
      failures.push(
        `${facet.name} has changed since audited commit ${facet.auditCommitHash}`
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

const loadAuditLog = (repoRoot: string): IAuditLogData =>
  JSON.parse(
    readFileSync(join(repoRoot, AUDIT_LOG_PATH), 'utf8')
  ) as IAuditLogData

/**
 * Lists the open pull requests whose head is this repository's given branch.
 * @param octokit - authenticated GitHub client
 * @param branch - branch name to match
 * @returns the matching open pull requests
 * @throws If the GitHub API call fails.
 */
const getOpenPRsForBranch = async (octokit: Octokit, branch: string) => {
  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner: OWNER,
    repo: REPO,
    state: 'open',
    head: `${OWNER}:${branch}`,
    per_page: PER_PAGE,
  })

  return pullRequests.filter((pullRequest) => pullRequest.head.ref === branch)
}

/** Git / audit-log / GitHub lookups the orchestrator needs. Injectable in tests. */
export interface IDeployGateDeps {
  mainRef: string
  fileMatchesRef: (ref: string, path: string) => boolean
  getContractVersion: (name: string) => Promise<string>
  resolveAuditCommitHash: (name: string, version: string) => string | undefined
  getOpenPrCount: (branch: string) => Promise<number>
}

/**
 * Builds the real git / audit-log / GitHub lookups used by the CLI.
 * `mainRef` and GitHub are resolved lazily so staging/`main` short-circuits
 * never touch the network or require a token.
 * @param repoRoot - repository root (working tree that will be compiled)
 * @param cliToken - `--token` value; empty when unset
 * @returns the git / audit-log / GitHub lookups used by the CLI
 */
export const createDefaultDeps = (
  repoRoot: string,
  cliToken: string | undefined
): IDeployGateDeps => {
  let mainRef: string | undefined
  let auditLog: IAuditLogData | undefined

  return {
    get mainRef() {
      return (mainRef ??= resolveMainRef(repoRoot))
    },
    fileMatchesRef: (ref, path) => fileMatchesRef(repoRoot, ref, path),
    getContractVersion,
    resolveAuditCommitHash: (name, version) => {
      auditLog ??= loadAuditLog(repoRoot)
      return resolveAuditCommitHash(auditLog, name, version)
    },
    getOpenPrCount: async (branch) => {
      const octokit = new Octokit({ auth: resolveGithubToken(cliToken) })
      const pullRequests = await getOpenPRsForBranch(octokit, branch)
      return pullRequests.length
    },
  }
}

/**
 * Compares the selected facets to `main` (and, if they differ, to their audit)
 * and evaluates the production deploy policy.
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
    const path = facetSourcePath(name)
    const matchesMain = deps.fileMatchesRef(deps.mainRef, path)
    if (matchesMain) {
      checks.push({ name, matchesMain: true })
      continue
    }

    const version = await deps.getContractVersion(name)
    const auditCommitHash = deps.resolveAuditCommitHash(name, version)
    const matchesAuditedCommit = auditCommitHash
      ? deps.fileMatchesRef(auditCommitHash, path)
      : false

    checks.push({
      name,
      matchesMain: false,
      version,
      auditCommitHash,
      matchesAuditedCommit,
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
    token: {
      type: 'string',
      description: 'Github access token (only required on the exception path)',
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
      createDefaultDeps(process.cwd(), args.token)
    )

    reportApprovalResult(failures)
  },
})

if (import.meta.main) runMain(main)
