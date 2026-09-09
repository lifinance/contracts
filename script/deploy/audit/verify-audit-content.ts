/**
 * The audit gate's decision: does the source at PR head match what was audited?
 *
 * Pure — the caller resolves each entry against git and passes the result in, so
 * the cases that only occur against GitHub are decidable without the network.
 */

import type { Hex } from 'viem'

import { classifyContentVerdict } from './closure-drift'
import type { IClosureComparison } from './closure-drift'
import type { IClosureDetail } from './source-closure'

/** Why a closure could not be computed at an audit commit. */
export type ClosureResolutionFailure =
  | 'unfetchable'
  | 'contract-absent'
  | 'closure-incomplete'

export interface IAuditEntryInput {
  auditId: string
  /**
   * Scope commit the auditor first reviewed (report “audited at”), or `"n/a"`
   * with explanation. Not necessarily what the gate pins to — see
   * {@link resolvePinCommit}.
   */
  auditCommitHash: string
  /**
   * Post-remediation commit the auditor signed off on. When set to a 40-hex
   * SHA, the gate pins content equality here; otherwise it falls back to
   * `auditCommitHash` (legacy entries and audits with no findings).
   */
  finalCommitHash?: string
  /** Recorded closure hash, once the schema field is populated. */
  sourceClosureHash?: Hex
  /**
   * Baseline pinned for an entry whose audit was never of a repo commit — a
   * forked contract, or an audit of one deployed instance. Not an audit result:
   * it makes later drift detectable without claiming the closure was reviewed.
   */
  pinnedClosureHash?: Hex
  /**
   * Closure recomputed at the pin commit ({@link resolvePinCommit}), or why it
   * could not be.
   */
  closureAtAuditCommit?: IClosureDetail | ClosureResolutionFailure
}

export type AuditEntryKind = 'recorded' | 'commit' | 'unverifiable'

export interface IAuditEntryClassification {
  kind: AuditEntryKind
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i

/**
 * Commit whose source the content gate accepts.
 *
 * Prefer `finalCommitHash` when it is a real SHA (post-remediation pin). Fall
 * back to `auditCommitHash` for legacy rows and audits with no remediations.
 *
 * @param entry - one audit log entry (or the gate's trimmed view of it).
 * @returns the 40-hex pin, or the trimmed `auditCommitHash` even when it is not a SHA.
 */
export const resolvePinCommit = (entry: {
  auditCommitHash: string
  finalCommitHash?: string
}): string => {
  const final = (entry.finalCommitHash ?? '').trim()
  if (COMMIT_SHA.test(final)) return final

  return (entry.auditCommitHash ?? '').trim()
}

/**
 * `closure-drift` reports without blocking, per D14: the contract's own source
 * is what was audited, and a shared library moving is worth surfacing rather
 * than treating as an unaudited contract.
 */
export type AuditVerdict = 'pass' | 'fail' | 'error' | 'closure-drift'

export interface IAuditCheckResult {
  verdict: AuditVerdict
  reason: string
  matchedAuditId?: string
  /** Closure files that moved since the audit, for a `closure-drift` verdict. */
  driftingDependencies?: string[]
}

/**
 * Which comparison an entry supports.
 *
 * `recorded` wins over `commit` when both are present: it is the direct
 * comparison and needs no fetch.
 *
 * @param entry - one audit entry for the contract@version under check.
 * @returns the comparison the entry supports.
 */
export const classifyAuditEntry = (
  entry: IAuditEntryInput
): IAuditEntryClassification => {
  if (entry.sourceClosureHash) return { kind: 'recorded' }
  if (COMMIT_SHA.test(resolvePinCommit(entry))) return { kind: 'commit' }

  return { kind: 'unverifiable' }
}

/**
 * Turns two closure details into the comparison the classifier reads.
 *
 * Returns `undefined` when the split cannot be made — no per-file detail at
 * head, or no contract path to tell the contract's own file from its imports.
 * The caller then falls back to the combined comparison, so a caller that
 * cannot supply detail keeps the old all-or-nothing behaviour rather than
 * silently getting the softer verdict.
 *
 * A file present on one side only counts as drift: an import appearing or
 * disappearing changes the closure just as much as one being edited.
 *
 * @param head - per-file hashes at PR head.
 * @param audited - per-file hashes at the audit commit.
 * @param contractPath - repo-relative path of the contract under check.
 * @returns the comparison, or `undefined` when it cannot be computed.
 */
const compareClosures = (
  head: IClosureDetail | undefined,
  audited: IClosureDetail,
  contractPath: string | undefined
): IClosureComparison | undefined => {
  if (!head || !contractPath) return undefined

  const ownAtHead = head.files[contractPath]
  const ownAtAudit = audited.files[contractPath]
  // The contract's own file must be present on both sides, or "its own source
  // is unchanged" is a claim about a file that was never read.
  if (ownAtHead === undefined || ownAtAudit === undefined) return undefined

  const paths = new Set([
    ...Object.keys(head.files),
    ...Object.keys(audited.files),
  ])
  paths.delete(contractPath)

  const driftingDependencies = [...paths]
    .filter((path) => head.files[path] !== audited.files[path])
    .sort()

  // A submodule moving is drift the per-file hashes cannot see, since their
  // contents are not repo-owned files in the closure.
  const dependencyDirs = new Set([
    ...Object.keys(head.dependencies),
    ...Object.keys(audited.dependencies),
  ])
  for (const dir of dependencyDirs)
    if (head.dependencies[dir] !== audited.dependencies[dir])
      driftingDependencies.push(dir)

  return {
    ownSourceMatches: ownAtHead === ownAtAudit,
    closureMatches: head.combined === audited.combined,
    driftingDependencies: driftingDependencies.sort(),
  }
}

export interface IVerifyAuditContentInput {
  contract: string
  version: string
  headClosureHash: Hex
  /** Per-file hashes at PR head. Absent only for callers that cannot produce them. */
  headClosureDetail?: IClosureDetail
  /** Repo-relative path of the contract, to tell its own file from its imports. */
  contractPath?: string
  entries: IAuditEntryInput[]
  /** Accepted for logging only — the gate has no title-based exemption. */
  prTitle?: string
}

/**
 * Named on every hard failure, because the commonest way to reach one is not tampering.
 *
 * Reports usually name scope commit A; remediations land at D. The gate pins to
 * `finalCommitHash` (D) when present, else `auditCommitHash`. Filing with only A
 * after fixes were made is the common miss — without this hint it looks like the
 * gate is broken.
 */
const REMEDIATION_HINT =
  'If this follows audit remediation, add a NEW audit entry with auditCommitHash=scope (A) and finalCommitHash=post-remediation (D) the auditor signed off on (same report / addendum OK). The append-only guard means an existing entry cannot be corrected in place.'

/**
 * Decides whether the audited source still matches PR head.
 *
 * Precedence is deliberate: any single passing audit settles the question.
 * Otherwise an ERROR outranks a FAIL — an unreachable commit means the gate does
 * not know, and per T3 not-knowing blocks with no acknowledgement path rather
 * than being reported as a mismatch.
 *
 * @param input - contract, version, head closure hash, and every audit entry already resolved against git.
 * @returns the verdict, a reason for the CI log, and the audit that proved it when one did.
 */
export const verifyAuditContent = (
  input: IVerifyAuditContentInput
): IAuditCheckResult => {
  const { contract, version, headClosureHash, entries } = input
  const subject = `${contract}@${version}`

  if (entries.length === 0)
    return {
      verdict: 'fail',
      reason: `${subject}: no audit entry found — an audit is required for every added or modified contract`,
    }

  const errors: string[] = []
  const failures: string[] = []
  const drifts: {
    reason: string
    auditId: string
    driftingDependencies: string[]
  }[] = []

  for (const entry of entries) {
    const { kind } = classifyAuditEntry(entry)

    if (kind === 'recorded') {
      if (entry.sourceClosureHash === headClosureHash)
        return {
          verdict: 'pass',
          reason: `${subject}: source closure matches the hash recorded on audit '${entry.auditId}'`,
          matchedAuditId: entry.auditId,
        }

      // A recorded hash is combined and carries no per-file detail, so on its own it cannot tell
      // the contract's own source changing from a dependency drifting. Without this, an entry
      // gaining a sourceClosureHash would start hard-blocking the very case the commit path
      // reports as drift, and the regression would look like the gate breaking for no reason.
      // The resolved closure at the same entry's commit supplies that detail when there is one;
      // when there is not, the recorded mismatch stands as the definite failure it is, rather
      // than being softened into the gate not knowing.
      const resolvedForSplit = entry.closureAtAuditCommit
      const recordedComparison =
        resolvedForSplit && typeof resolvedForSplit !== 'string'
          ? compareClosures(
              input.headClosureDetail,
              resolvedForSplit,
              input.contractPath
            )
          : undefined

      if (recordedComparison) {
        const classified = classifyContentVerdict(subject, recordedComparison)
        if (classified.verdict === 'closure-drift') {
          drifts.push({
            reason: `${classified.reason} (audit '${entry.auditId}', recorded hash ${entry.sourceClosureHash})`,
            auditId: entry.auditId,
            driftingDependencies: recordedComparison.driftingDependencies,
          })
          continue
        }
      }

      failures.push(
        `audit '${entry.auditId}': recorded sourceClosureHash ${entry.sourceClosureHash} does not match PR head ${headClosureHash}`
      )
      continue
    }

    if (kind === 'commit') {
      const pinCommit = resolvePinCommit(entry)
      const resolved = entry.closureAtAuditCommit

      if (resolved === 'unfetchable') {
        errors.push(
          `audit '${entry.auditId}': pin commit ${pinCommit} could not be fetched from GitHub, so the audited source cannot be compared`
        )
        continue
      }

      if (resolved === 'contract-absent') {
        errors.push(
          `audit '${entry.auditId}': ${contract} does not exist at pin commit ${pinCommit}, so that entry cannot describe this contract`
        )
        continue
      }

      // A partial closure would hash confidently over the files it did read, so
      // this must block rather than compare — the unread files are exactly where
      // an undetected change would hide.
      if (resolved === 'closure-incomplete') {
        errors.push(
          `audit '${entry.auditId}': the import closure at pin commit ${pinCommit} could not be fully read, so no hash over it can be trusted`
        )
        continue
      }

      if (resolved === undefined) {
        errors.push(
          `audit '${entry.auditId}': the closure at pin commit ${pinCommit} was not resolved`
        )
        continue
      }

      if (resolved.combined === headClosureHash)
        return {
          verdict: 'pass',
          reason: `${subject}: source closure is byte-identical to the audited source at pin commit ${pinCommit} (audit '${entry.auditId}')`,
          matchedAuditId: entry.auditId,
        }

      // The combined hash says something moved but not what. Splitting it is the
      // whole point: a contract whose own file is unchanged is still the audited
      // contract, and blocking it would block every contract sharing a library
      // that moved.
      const comparison = compareClosures(
        input.headClosureDetail,
        resolved,
        input.contractPath
      )
      if (comparison) {
        const classified = classifyContentVerdict(subject, comparison)
        if (classified.verdict === 'closure-drift') {
          drifts.push({
            reason: `${classified.reason} (audit '${entry.auditId}', pin commit ${pinCommit})`,
            auditId: entry.auditId,
            driftingDependencies: comparison.driftingDependencies,
          })
          continue
        }
      }

      failures.push(
        `audit '${entry.auditId}': closure at pin commit ${pinCommit} is ${resolved.combined}, PR head is ${headClosureHash} — the contract changed after it was audited`
      )
      continue
    }

    if (entry.pinnedClosureHash === undefined) {
      errors.push(
        `audit '${entry.auditId}': auditCommitHash is not a commit ("${entry.auditCommitHash}") and no pinned baseline is recorded, so there is nothing to compare against`
      )
      continue
    }

    if (entry.pinnedClosureHash === headClosureHash)
      return {
        verdict: 'pass',
        reason: `${subject}: source closure matches the pinned baseline on audit '${entry.auditId}' (that audit was not of a repo commit)`,
        matchedAuditId: entry.auditId,
      }

    failures.push(
      `audit '${entry.auditId}': pinned baseline ${entry.pinnedClosureHash} does not match PR head ${headClosureHash}`
    )
  }

  if (errors.length > 0)
    return {
      verdict: 'error',
      reason: `${subject}: the audit gate could not reach a verdict:\n  ${errors.join(
        '\n  '
      )}`,
    }

  // Only when no entry produced a hard failure. One audit finding the contract's
  // own source changed is not softened by another finding merely drift.
  const [best] = drifts
  if (failures.length === 0 && best) {
    return {
      verdict: 'closure-drift',
      reason: best.reason,
      matchedAuditId: best.auditId,
      driftingDependencies: best.driftingDependencies,
    }
  }

  return {
    verdict: 'fail',
    reason: `${subject}: no audit covers the source at PR head:\n  ${failures.join(
      '\n  '
    )}\n  ${REMEDIATION_HINT}`,
  }
}
