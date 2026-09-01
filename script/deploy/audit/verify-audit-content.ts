/**
 * The audit gate's decision: does the source at PR head match what was audited?
 *
 * Pure — the caller resolves each entry against git and passes the result in, so
 * the cases that only occur against GitHub are decidable without the network.
 */

import type { Hex } from 'viem'

/** Why a closure could not be computed at an audit commit. */
export type ClosureResolutionFailure =
  | 'unfetchable'
  | 'contract-absent'
  | 'closure-incomplete'

export interface IAuditEntryInput {
  auditId: string
  auditCommitHash: string
  /** Recorded closure hash, once the schema field is populated. */
  sourceClosureHash?: Hex
  /**
   * Baseline pinned for an entry whose audit was never of a repo commit — a
   * forked contract, or an audit of one deployed instance. Not an audit result:
   * it makes later drift detectable without claiming the closure was reviewed.
   */
  pinnedClosureHash?: Hex
  /** Closure recomputed at `auditCommitHash`, or why it could not be. */
  closureAtAuditCommit?: Hex | ClosureResolutionFailure
}

export type AuditEntryKind = 'recorded' | 'commit' | 'unverifiable'

export interface IAuditEntryClassification {
  kind: AuditEntryKind
}

export type AuditVerdict = 'pass' | 'fail' | 'error'

export interface IAuditCheckResult {
  verdict: AuditVerdict
  reason: string
  matchedAuditId?: string
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i

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
  if (COMMIT_SHA.test((entry.auditCommitHash ?? '').trim()))
    return { kind: 'commit' }

  return { kind: 'unverifiable' }
}

export interface IVerifyAuditContentInput {
  contract: string
  version: string
  headClosureHash: Hex
  entries: IAuditEntryInput[]
  /** Accepted for logging only — the gate has no title-based exemption. */
  prTitle?: string
}

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

  for (const entry of entries) {
    const { kind } = classifyAuditEntry(entry)

    if (kind === 'recorded') {
      if (entry.sourceClosureHash === headClosureHash)
        return {
          verdict: 'pass',
          reason: `${subject}: source closure matches the hash recorded on audit '${entry.auditId}'`,
          matchedAuditId: entry.auditId,
        }

      failures.push(
        `audit '${entry.auditId}': recorded sourceClosureHash ${entry.sourceClosureHash} does not match PR head ${headClosureHash}`
      )
      continue
    }

    if (kind === 'commit') {
      const resolved = entry.closureAtAuditCommit

      if (resolved === 'unfetchable') {
        errors.push(
          `audit '${entry.auditId}': commit ${entry.auditCommitHash} could not be fetched from GitHub, so the audited source cannot be compared`
        )
        continue
      }

      if (resolved === 'contract-absent') {
        errors.push(
          `audit '${entry.auditId}': ${contract} does not exist at commit ${entry.auditCommitHash}, so that entry cannot describe this contract`
        )
        continue
      }

      // A partial closure would hash confidently over the files it did read, so
      // this must block rather than compare — the unread files are exactly where
      // an undetected change would hide.
      if (resolved === 'closure-incomplete') {
        errors.push(
          `audit '${entry.auditId}': the import closure at commit ${entry.auditCommitHash} could not be fully read, so no hash over it can be trusted`
        )
        continue
      }

      if (resolved === undefined) {
        errors.push(
          `audit '${entry.auditId}': the closure at commit ${entry.auditCommitHash} was not resolved`
        )
        continue
      }

      if (resolved === headClosureHash)
        return {
          verdict: 'pass',
          reason: `${subject}: source closure is byte-identical to the audited source at commit ${entry.auditCommitHash} (audit '${entry.auditId}')`,
          matchedAuditId: entry.auditId,
        }

      failures.push(
        `audit '${entry.auditId}': closure at audited commit ${entry.auditCommitHash} is ${resolved}, PR head is ${headClosureHash} — the contract changed after it was audited`
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

  return {
    verdict: 'fail',
    reason: `${subject}: no audit covers the source at PR head:\n  ${failures.join(
      '\n  '
    )}`,
  }
}
