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
