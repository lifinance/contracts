/**
 * Selects the audit entries a contract must be judged against, resolves each one
 * against git, and folds the per-contract verdicts into one gate result.
 *
 * `verify-audit-content.ts` holds the decision table and stays pure;
 * `source-closure.ts` hashes a tree; this module is the seam between them. Git
 * arrives as {@link IAuditGateDeps} rather than being called directly, so the
 * cases that only occur against GitHub — an unfetchable audit commit above all —
 * are testable without the network.
 */

import type { Hex } from 'viem'

import type { AuditLogEntry, IAuditLogFile } from './audit-log-guard'
import {
  verifyAuditContent,
  type AuditVerdict,
  type ClosureResolutionFailure,
  type IAuditCheckResult,
  type IAuditEntryInput,
} from './verify-audit-content'

/** A closure hash at a tree-ish, or why one could not be taken. */
export type ClosureAtResult = Hex | ClosureResolutionFailure

export interface IAuditGateDeps {
  /**
   * Hashes `contractPath`'s full import closure as of `treeish`. Implementations
   * fetch an unreachable commit before giving up; see `git-source-reader.ts`.
   */
  closureAt: (treeish: string, contractPath: string) => ClosureAtResult
}

export interface IContractUnderCheck {
  /** Repo-relative path, e.g. `src/Facets/FooFacet.sol`. */
  path: string
  /** `@custom:version` at PR head. */
  version: string
}

export interface IContractGateResult extends IAuditCheckResult {
  contract: string
  version: string
}

export interface IAuditGateReport {
  results: IContractGateResult[]
  /** ERROR outranks FAIL outranks PASS, per T3. */
  verdict: AuditVerdict
  /** True for anything other than PASS. Not-knowing blocks like a mismatch. */
  blocked: boolean
}

export interface IAuditGateInput {
  log: IAuditLogFile
  contracts: IContractUnderCheck[]
  /** Tree-ish holding PR head, normally `HEAD`. */
  headTreeish: string
  deps: IAuditGateDeps
  /** Logged only. The gate has no title-based exemption — see A0.5. */
  prTitle?: string
}

/**
 * The audit log keys contracts by bare name, the workflow carries paths.
 *
 * @param path - repo-relative path of a contract.
 * @returns the contract name the audit log uses.
 */
export const contractNameFromPath = (path: string): string =>
  (path.split('/').pop() ?? path).replace(/\.sol$/, '')

/**
 * Mirrors the `@custom:version` extraction in `versionControlAndAuditCheck.yml`
 * exactly — anchored, three numeric components. The two must agree: the workflow
 * looks up audit coverage by version while the gate compares content at that
 * same version, and a disagreement would check one version's audits against
 * another version's source.
 *
 * `getContractVersion()` in `script/deploy/shared/` is not reusable here: it
 * resolves a contract *name* by guessing among `src/`, `src/Facets/` and
 * friends, so two same-named contracts collapse, and it reads the working tree
 * rather than a tree-ish.
 *
 * @param source - Solidity source text.
 * @returns the declared version, or undefined when the tag is absent.
 */
export const extractContractVersion = (
  source: string
): string | undefined =>
  /^\/\/\/\s*@custom:version\s+(\d+\.\d+\.\d+)/m.exec(source)?.[1]

/**
 * Splits the version-control step's contract list.
 *
 * That step writes comma-separated; a hand-run invocation is far more readable
 * newline-separated, so both are accepted.
 *
 * @param raw - contents of `contracts_for_audit.txt`, or a `--contracts` value.
 * @returns repo-relative contract paths, blanks dropped.
 */
export const parseContractList = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const HEX = /^0x[0-9a-f]{64}$/i

const isClosureHash = (value: ClosureAtResult): value is Hex => HEX.test(value)

const asHex = (value: string | undefined): Hex | undefined =>
  value !== undefined && HEX.test(value) ? (value as Hex) : undefined

const toEntryInput = (
  auditId: string,
  entry: AuditLogEntry
): IAuditEntryInput => ({
  auditId,
  auditCommitHash: entry.auditCommitHash ?? '',
  sourceClosureHash: asHex(entry.sourceClosureHash),
  pinnedClosureHash: asHex(entry.pinnedClosureHash),
})

/**
 * Gathers the audits logged for one contract at one version.
 *
 * An id listed under `auditedContracts` with no matching `audits` entry is
 * dropped rather than substituted: a dangling id must reduce the evidence, never
 * become evidence. Duplicated ids collapse, so listing an audit twice cannot
 * make a contract look better covered than it is.
 *
 * @param log - the parsed audit log.
 * @param contractName - bare contract name, as the log keys it.
 * @param version - `@custom:version` at PR head.
 * @returns one input per distinct, resolvable audit id.
 */
export const collectEntriesForContract = (
  log: IAuditLogFile,
  contractName: string,
  version: string
): IAuditEntryInput[] => {
  const auditIds = log.auditedContracts?.[contractName]?.[version] ?? []

  return [...new Set(auditIds)].flatMap((auditId) => {
    const entry = log.audits?.[auditId]
    return entry ? [toEntryInput(auditId, entry)] : []
  })
}

const worst = (verdicts: AuditVerdict[]): AuditVerdict => {
  if (verdicts.includes('error')) return 'error'
  if (verdicts.includes('fail')) return 'fail'

  return 'pass'
}

/**
 * Runs the content-equality gate over every contract the PR touches.
 *
 * Closure reads are memoised across contracts, because a rollout PR routinely
 * shares one audit commit between many facets and each read is a git subprocess.
 *
 * Every contract is evaluated even after one blocks, so an author sees the whole
 * picture in a single CI run rather than one failure per push.
 *
 * @param input - the log, the contracts at PR head, the head tree-ish, and injected git.
 * @returns per-contract results plus the folded verdict.
 */
export const runAuditGate = (input: IAuditGateInput): IAuditGateReport => {
  const { log, contracts, headTreeish, deps } = input
  const cache = new Map<string, ClosureAtResult>()

  const closureAt = (treeish: string, path: string): ClosureAtResult => {
    const key = `${treeish}:${path}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached

    const resolved = deps.closureAt(treeish, path)
    cache.set(key, resolved)

    return resolved
  }

  const results = contracts.map((contract): IContractGateResult => {
    const name = contractNameFromPath(contract.path)
    const subject = `${name}@${contract.version}`
    const head = closureAt(headTreeish, contract.path)

    // Not knowing what is being merged is an ERROR, never a pass: the gate has
    // nothing to compare, and per T3 that blocks without an acknowledgement path.
    if (!isClosureHash(head))
      return {
        contract: name,
        version: contract.version,
        verdict: 'error',
        reason: `${subject}: the source closure at PR head could not be computed (${head}) — the gate cannot compare what it cannot read`,
      }

    const entries = collectEntriesForContract(log, name, contract.version).map(
      (entry) => ({
        ...entry,
        closureAtAuditCommit: /^[0-9a-f]{40}$/i.test(entry.auditCommitHash)
          ? closureAt(entry.auditCommitHash, contract.path)
          : undefined,
      })
    )

    return {
      contract: name,
      version: contract.version,
      ...verifyAuditContent({
        contract: name,
        version: contract.version,
        headClosureHash: head,
        entries,
        prTitle: input.prTitle,
      }),
    }
  })

  const verdict = worst(results.map((result) => result.verdict))

  return { results, verdict, blocked: verdict !== 'pass' }
}
