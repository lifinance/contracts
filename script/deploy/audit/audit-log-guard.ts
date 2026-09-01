/**
 * Append-only guard for `audit/auditLog.json`.
 *
 * The content-equality audit gate records its expectation in this file, so a PR
 * author who can edit an existing entry can defeat the gate within the same PR.
 * This compares the file on the base branch with the file at PR head and reports
 * every mutation of recorded history. Adding entries, contracts, versions and
 * audit ids stays free.
 *
 * Import this from the CI guard; it performs no I/O so the diff can be unit
 * tested against fixtures.
 */

export type AuditLogEntry = Record<string, string>

export interface IAuditLogFile {
  audits: Record<string, AuditLogEntry | undefined>
  auditedContracts: Record<
    string,
    Record<string, string[] | undefined> | undefined
  >
}

export type AuditLogViolationKind =
  | 'entry-removed'
  | 'field-changed'
  | 'field-removed'
  | 'coverage-removed'

export interface IAuditLogViolation {
  kind: AuditLogViolationKind
  /** Audit id for entry-level violations. */
  auditId?: string
  /** Contract or contract@version for coverage violations. */
  subject?: string
  field?: string
  before?: string
  after?: string
}

export interface IAuditLogDiff {
  violations: IAuditLogViolation[]
}

/**
 * Compares two states of the audit log.
 *
 * Every violation is collected rather than short-circuiting on the first: an
 * author fixing one tampered field should see all of them in a single CI run.
 *
 * @param before - the file as it stands on the base branch.
 * @param after - the file at PR head.
 * @returns every way `after` mutates history recorded in `before`.
 */
export const diffAuditLog = (
  before: IAuditLogFile,
  after: IAuditLogFile
): IAuditLogDiff => {
  const violations: IAuditLogViolation[] = []

  for (const [auditId, previous] of Object.entries(before.audits ?? {})) {
    if (!previous) continue

    const current = after.audits?.[auditId]
    if (!current) {
      violations.push({ kind: 'entry-removed', auditId })
      continue
    }

    for (const [field, value] of Object.entries(previous))
      if (!(field in current))
        violations.push({
          kind: 'field-removed',
          auditId,
          field,
          before: value,
        })
      else if (current[field] !== value)
        violations.push({
          kind: 'field-changed',
          auditId,
          field,
          before: value,
          after: current[field],
        })
  }

  for (const [contract, versions] of Object.entries(
    before.auditedContracts ?? {}
  )) {
    if (!versions) continue

    const currentVersions = after.auditedContracts?.[contract]
    if (!currentVersions) {
      violations.push({
        kind: 'coverage-removed',
        subject: contract,
        before: Object.keys(versions).join(', '),
      })
      continue
    }

    for (const [version, ids] of Object.entries(versions)) {
      if (!ids) continue

      const currentIds = currentVersions[version]
      if (!currentIds) {
        violations.push({
          kind: 'coverage-removed',
          subject: `${contract}@${version}`,
          before: ids.join(', '),
        })
        continue
      }

      // Membership, not length: replacing one id with another keeps the count
      // while silently re-pointing the version at a different audit.
      const dropped = ids.filter((id) => !currentIds.includes(id))
      if (dropped.length > 0)
        violations.push({
          kind: 'coverage-removed',
          subject: `${contract}@${version}`,
          before: dropped.join(', '),
          after: currentIds.join(', '),
        })
    }
  }

  return { violations }
}

const describe = (violation: IAuditLogViolation): string => {
  const subject = violation.auditId ?? violation.subject ?? '(unknown)'
  switch (violation.kind) {
    case 'entry-removed':
      return `  audit entry '${subject}' was removed — audit history is append-only`
    case 'field-removed':
      return `  audit entry '${subject}': field '${violation.field}' was removed (was: ${violation.before})`
    case 'field-changed':
      return `  audit entry '${subject}': field '${violation.field}' changed from '${violation.before}' to '${violation.after}'`
    case 'coverage-removed':
      return `  audited coverage for '${subject}' lost audit id(s): ${
        violation.before
      }${violation.after ? ` (now: ${violation.after})` : ''}`
    default:
      return `  unrecognised violation on '${subject}'`
  }
}

/**
 * @param violations - from {@link diffAuditLog}.
 * @returns a human-readable block for the CI log, or an empty string when clean.
 */
export const formatAuditLogViolations = (
  violations: IAuditLogViolation[]
): string => violations.map(describe).join('\n')

export type AppendOnlyVerdict = 'pass' | 'fail' | 'error'

export interface IAppendOnlyDecision {
  verdict: AppendOnlyVerdict
  reason: string
}

export interface IAppendOnlyInput {
  auditLogPath: string
  baseTreeish: string
  headTreeish: string
  /** Whether `baseTreeish` resolved to a commit that is present locally. */
  baseResolved: boolean
  before: IAuditLogFile | undefined
  after: IAuditLogFile | undefined
}

/**
 * Decides whether a PR leaves the audit log append-only.
 *
 * The `baseResolved` flag is load-bearing rather than defensive. A git read
 * returns nothing both when the file is absent at a readable commit and when the
 * commit itself could not be read, and those must not share a verdict: this log
 * has existed for the whole life of the repo, so "absent at base" on a real base
 * commit means the read failed, and answering that with "nothing recorded yet"
 * would report a broken guard as a clean one.
 *
 * @param input - both log versions, the tree-ishes they came from, and whether the base resolved.
 * @returns the verdict and a reason naming what blocked it.
 */
export const decideAppendOnly = (
  input: IAppendOnlyInput
): IAppendOnlyDecision => {
  const {
    auditLogPath,
    baseTreeish,
    headTreeish,
    baseResolved,
    before,
    after,
  } = input

  // Checked ahead of an unresolvable base: deleting the log discards every
  // recorded expectation at once, so it is the finding worth naming.
  if (after === undefined)
    return {
      verdict: 'fail',
      reason: `${auditLogPath} does not exist at ${headTreeish}. The audit log cannot be removed.`,
    }

  if (!baseResolved)
    return {
      verdict: 'error',
      reason: `${auditLogPath} could not be compared: the PR base ${baseTreeish} could not be resolved to a commit, so the guard cannot tell an untouched log from a rewritten one`,
    }

  if (before === undefined)
    return {
      verdict: 'pass',
      reason: `${auditLogPath} does not exist at ${baseTreeish} — nothing recorded yet, so nothing can have been rewritten.`,
    }

  const { violations } = diffAuditLog(before, after)

  if (violations.length === 0)
    return {
      verdict: 'pass',
      reason: `${auditLogPath} is append-only in this PR: no existing entry was changed or removed.`,
    }

  return {
    verdict: 'fail',
    reason: `${formatAuditLogViolations(
      violations
    )}\nThe audit log is append-only. ${
      violations.length
    } existing record(s) were modified or removed — add new entries instead.`,
  }
}
