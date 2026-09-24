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
import { classifyContentVerdict } from './closure-drift'
import type { IClosureDetail } from './source-closure'
import {
  verifyAuditContent,
  resolvePinCommit,
  type AuditVerdict,
  type ClosureResolutionFailure,
  type IAuditCheckResult,
  type IAuditEntryInput,
} from './verify-audit-content'

/** A closure at a tree-ish, hashed whole and per file, or why one could not be taken. */
export type ClosureAtResult = IClosureDetail | ClosureResolutionFailure

export interface IAuditGateDeps {
  /**
   * Hashes `contractPath`'s full import closure as of `treeish`. Implementations
   * fetch an unreachable commit before giving up; see `git-source-reader.ts`.
   */
  closureAt: (treeish: string, contractPath: string) => ClosureAtResult
  /**
   * `@custom:version` of `path` at `treeish`, or `undefined` when the file is
   * absent or carries no well-formed tag. Lets a drifted import be judged
   * against its own audit.
   */
  versionAt: (treeish: string, path: string) => string | undefined
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
  /**
   * Whether the merge is stopped. True for ERROR and FAIL — not-knowing blocks
   * like a mismatch. `closure-drift` is reported and does not block.
   */
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

/**
 * Where the contract list is coming from, or that the caller never said.
 *
 * `absent` exists because citty drops an unrecognised flag silently: a renamed
 * or mistyped `--contracts-file` would otherwise leave the list empty, and an
 * empty list is a legitimate pass ("no contract needs an audit"). A gate that
 * reports success because nobody told it what to check is worse than one that
 * fails, so the two cases are separated here rather than collapsing to `''`.
 */
export type ContractSourceResolution =
  | { kind: 'provided'; raw: string }
  | { kind: 'file'; path: string }
  | { kind: 'absent' }

/**
 * Decides where to read the contract list from.
 *
 * @param args - the `--contracts` and `--contracts-file` values as parsed.
 * @returns the inline list, the file to read, or that neither was supplied.
 */
export const resolveContractSource = (args: {
  contracts?: string
  contractsFile?: string
}): ContractSourceResolution => {
  if (args.contracts !== undefined)
    return { kind: 'provided', raw: args.contracts }
  if (args.contractsFile !== undefined)
    return { kind: 'file', path: args.contractsFile }

  return { kind: 'absent' }
}

const HEX = /^0x[0-9a-f]{64}$/i

const isClosureDetail = (value: ClosureAtResult): value is IClosureDetail =>
  typeof value === 'object' && value !== null && 'combined' in value

const asHex = (value: string | undefined): Hex | undefined =>
  value !== undefined && HEX.test(value.trim())
    ? (value.trim().toLowerCase() as Hex)
    : undefined

const toEntryInput = (
  auditId: string,
  entry: AuditLogEntry
): IAuditEntryInput => ({
  auditId,
  // Trimmed here and nowhere else: this module tests the raw value to decide
  // whether to resolve a closure while the decision table tests a trimmed one,
  // so a stray newline in the JSON made them disagree and produced "the closure
  // was not resolved" — an error that names neither the cause nor the fix.
  auditCommitHash: (entry.auditCommitHash ?? '').trim(),
  finalCommitHash: entry.finalCommitHash?.trim() || undefined,
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
  // Ranked above pass so one drifting contract is still reported when the rest
  // of the PR is clean, and below fail so it never softens a real mismatch.
  if (verdicts.includes('closure-drift')) return 'closure-drift'

  return 'pass'
}

/**
 * Re-judges a `closure-drift` verdict after crediting every drifted import that
 * passes the gate on its own.
 *
 * An import whose current source matches its own audit is not unreviewed code,
 * so it is dropped from the drift. Only a `pass` credits: an import that itself
 * drifts, fails or cannot be judged stays listed. Without this, a fork that
 * carries an audited library overlay (`LibAsset@2.1.3-tron`) reports drift on
 * every contract importing it, permanently.
 *
 * @param subject - `Name@version`, for the reason line.
 * @param result - the verdict before crediting.
 * @param coveredLabel - `Name@version (audit 'id')` for a covered import, else `undefined`.
 * @returns the verdict unchanged, a `pass` when every drifted import is covered,
 * or a narrower `closure-drift` listing only the uncovered ones.
 */
const creditCoveredDependencies = (
  subject: string,
  result: IAuditCheckResult,
  coveredLabel: (path: string) => string | undefined
): IAuditCheckResult => {
  if (result.verdict !== 'closure-drift') return result

  const covered: string[] = []
  const uncovered: string[] = []
  for (const path of result.driftingDependencies ?? []) {
    const label = coveredLabel(path)
    if (label) covered.push(label)
    else uncovered.push(path)
  }
  if (covered.length === 0) return result

  const credit = `covered by their own audits: ${covered.join(', ')}`
  if (uncovered.length === 0)
    return {
      verdict: 'pass',
      reason: `${subject}: own source matches audit '${result.matchedAuditId}', and every import that moved since is ${credit}`,
      matchedAuditId: result.matchedAuditId,
    }

  const { reason } = classifyContentVerdict(subject, {
    ownSourceMatches: true,
    closureMatches: false,
    driftingDependencies: uncovered,
  })
  return {
    ...result,
    reason: `${reason} (audit '${result.matchedAuditId}'; other moved imports are ${credit})`,
    driftingDependencies: uncovered,
  }
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

  const judge = (contract: IContractUnderCheck): IContractGateResult => {
    const name = contractNameFromPath(contract.path)
    const subject = `${name}@${contract.version}`
    const head = closureAt(headTreeish, contract.path)

    // Not knowing what is being merged is an ERROR, never a pass: the gate has
    // nothing to compare, and per T3 that blocks without an acknowledgement path.
    if (!isClosureDetail(head))
      return {
        contract: name,
        version: contract.version,
        verdict: 'error',
        reason: `${subject}: the source closure at PR head could not be computed (${head}) — the gate cannot compare what it cannot read`,
      }

    const entries = collectEntriesForContract(log, name, contract.version).map(
      (entry) => {
        const pinCommit = resolvePinCommit(entry)
        return {
          ...entry,
          closureAtAuditCommit: /^[0-9a-f]{40}$/i.test(pinCommit)
            ? closureAt(pinCommit, contract.path)
            : undefined,
        }
      }
    )

    return {
      contract: name,
      version: contract.version,
      ...verifyAuditContent({
        contract: name,
        version: contract.version,
        headClosureHash: head.combined,
        headClosureDetail: head,
        contractPath: contract.path,
        entries,
        prTitle: input.prTitle,
      }),
    }
  }

  const evaluated = new Map<string, IContractGateResult>()
  const inProgress = new Set<string>()

  const coveredLabel = (path: string): string | undefined => {
    // Submodule dirs have no version and no audit entry of their own.
    if (!path.endsWith('.sol')) return undefined
    const version = deps.versionAt(headTreeish, path)
    if (version === undefined) return undefined

    const result = evaluate({ path, version })
    return result.verdict === 'pass'
      ? `${result.contract}@${version} (audit '${result.matchedAuditId}')`
      : undefined
  }

  const evaluate = (contract: IContractUnderCheck): IContractGateResult => {
    const key = `${contract.path}@${contract.version}`
    const done = evaluated.get(key)
    if (done) return done

    // A contract reached again through its own imports is still being judged, so
    // it cannot vouch for anything yet. Not cached: it is a placeholder, not a verdict.
    if (inProgress.has(key))
      return {
        contract: contractNameFromPath(contract.path),
        version: contract.version,
        verdict: 'closure-drift',
        reason: `${contract.path}@${contract.version}: reached through an import cycle`,
      }

    inProgress.add(key)
    const base = judge(contract)
    const result: IContractGateResult = {
      contract: base.contract,
      version: base.version,
      ...creditCoveredDependencies(
        `${base.contract}@${base.version}`,
        base,
        coveredLabel
      ),
    }
    inProgress.delete(key)
    evaluated.set(key, result)

    return result
  }

  const results = contracts.map(evaluate)

  const verdict = worst(results.map((result) => result.verdict))

  // `closure-drift` reports without blocking, per D14 — it is the one non-pass
  // verdict that does not stop a merge.
  return {
    results,
    verdict,
    blocked: verdict === 'error' || verdict === 'fail',
  }
}
