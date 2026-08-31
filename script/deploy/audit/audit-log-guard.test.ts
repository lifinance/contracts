/**
 * Unit tests for the append-only guard on `audit/auditLog.json`.
 *
 * The content-equality gate records its expectation in this file, so a PR author
 * who can edit an existing entry can defeat the gate in the same PR. These tests
 * pin exactly what may and may not change.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { diffAuditLog, formatAuditLogViolations } from './audit-log-guard'

/** Concrete shape so fixtures need no non-null assertions. */
interface IConcreteLog {
  audits: Record<string, Record<string, string>>
  auditedContracts: Record<string, Record<string, string[]>>
}

const entry = (
  overrides: Record<string, string> = {}
): Record<string, string> => ({
  auditCompletedOn: '01.02.2026',
  auditedBy: 'Cantina',
  auditorGitHandle: 'someauditor',
  auditReportPath: './audit/reports/2026.02.01_Foo.pdf',
  auditCommitHash: 'a'.repeat(40),
  ...overrides,
})

const base: IConcreteLog = {
  audits: { audit1: entry(), audit2: entry({ auditedBy: 'Sujith' }) },
  auditedContracts: { FooFacet: { '1.0.0': ['audit1'] } },
}

const clone = (value: IConcreteLog): IConcreteLog =>
  JSON.parse(JSON.stringify(value))

const diff = (before: IConcreteLog, after: IConcreteLog) =>
  diffAuditLog(before, after)

/** Definitely-defined accessors — the fixtures always contain these keys. */
const auditOf = (log: IConcreteLog, id: string): Record<string, string> => {
  const found = log.audits[id]
  if (!found) throw new Error(`fixture has no audit '${id}'`)
  return found
}

const versionsOf = (
  log: IConcreteLog,
  contract: string
): Record<string, string[]> => {
  const found = log.auditedContracts[contract]
  if (!found) throw new Error(`fixture has no contract '${contract}'`)
  return found
}

describe('diffAuditLog — what is allowed', () => {
  it('passes an unchanged file', () => {
    expect(diff(base, clone(base)).violations).toEqual([])
  })

  it('allows adding a brand-new audit entry', () => {
    const next = clone(base)
    next.audits.audit3 = entry({ auditedBy: 'Trail of Bits' })
    expect(diff(base, next).violations).toEqual([])
  })

  it('allows adding a new contract to auditedContracts', () => {
    const next = clone(base)
    next.auditedContracts.BarFacet = { '1.0.0': ['audit1'] }
    expect(diff(base, next).violations).toEqual([])
  })

  it('allows adding a new version to an existing contract', () => {
    const next = clone(base)
    versionsOf(next, 'FooFacet')['1.1.0'] = ['audit2']
    expect(diff(base, next).violations).toEqual([])
  })

  it('allows appending an audit id to an existing version', () => {
    const next = clone(base)
    versionsOf(next, 'FooFacet')['1.0.0'] = ['audit1', 'audit2']
    expect(diff(base, next).violations).toEqual([])
  })

  it('allows adding sourceClosureHash to an entry that had none', () => {
    const next = clone(base)
    auditOf(next, 'audit1').sourceClosureHash = `0x${'1'.repeat(64)}`
    expect(diff(base, next).violations).toEqual([])
  })
})

describe('diffAuditLog — what is blocked', () => {
  it('blocks changing auditCommitHash on an existing entry', () => {
    const next = clone(base)
    auditOf(next, 'audit1').auditCommitHash = 'b'.repeat(40)
    const { violations } = diff(base, next)

    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('field-changed')
    expect(violations[0]?.auditId).toBe('audit1')
    expect(violations[0]?.field).toBe('auditCommitHash')
  })

  it('blocks changing a recorded sourceClosureHash — the gate compares on it', () => {
    const withHash = clone(base)
    auditOf(withHash, 'audit1').sourceClosureHash = `0x${'1'.repeat(64)}`
    const next = clone(withHash)
    auditOf(next, 'audit1').sourceClosureHash = `0x${'2'.repeat(64)}`

    expect(diff(withHash, next).violations[0]?.field).toBe('sourceClosureHash')
  })

  it.each([
    ['auditCompletedOn'],
    ['auditedBy'],
    ['auditorGitHandle'],
    ['auditReportPath'],
  ])('blocks changing %s', (field) => {
    const next = clone(base)
    auditOf(next, 'audit1')[field] = 'tampered'
    expect(diff(base, next).violations[0]?.field).toBe(field)
  })

  it('blocks deleting an audit entry', () => {
    const next = clone(base)
    delete next.audits.audit2
    const { violations } = diff(base, next)

    expect(violations[0]?.kind).toBe('entry-removed')
    expect(violations[0]?.auditId).toBe('audit2')
  })

  it('blocks removing a field from an existing entry', () => {
    const next = clone(base)
    delete auditOf(next, 'audit1').auditCommitHash
    expect(diff(base, next).violations[0]?.kind).toBe('field-removed')
  })

  it('blocks removing a contract from auditedContracts', () => {
    const next = clone(base)
    delete next.auditedContracts.FooFacet
    expect(diff(base, next).violations[0]?.kind).toBe('coverage-removed')
  })

  it('blocks removing a version from an existing contract', () => {
    const withTwo = clone(base)
    versionsOf(withTwo, 'FooFacet')['1.1.0'] = ['audit2']
    const next = clone(withTwo)
    delete versionsOf(next, 'FooFacet')['1.1.0']

    expect(diff(withTwo, next).violations[0]?.kind).toBe('coverage-removed')
  })

  it('blocks dropping an audit id from an existing version', () => {
    const withTwo = clone(base)
    versionsOf(withTwo, 'FooFacet')['1.0.0'] = ['audit1', 'audit2']
    const next = clone(withTwo)
    versionsOf(next, 'FooFacet')['1.0.0'] = ['audit1']

    expect(diff(withTwo, next).violations[0]?.kind).toBe('coverage-removed')
  })

  it('blocks REPLACING an audit id, even though the count is unchanged', () => {
    const next = clone(base)
    versionsOf(next, 'FooFacet')['1.0.0'] = ['audit2']
    expect(diff(base, next).violations[0]?.kind).toBe('coverage-removed')
  })

  it('reports every violation, not just the first', () => {
    const next = clone(base)
    auditOf(next, 'audit1').auditCommitHash = 'b'.repeat(40)
    auditOf(next, 'audit1').auditedBy = 'tampered'
    delete next.audits.audit2

    expect(diff(base, next).violations.length).toBeGreaterThanOrEqual(3)
  })
})

describe('formatAuditLogViolations', () => {
  it('names the entry, the field, and both values', () => {
    const next = clone(base)
    auditOf(next, 'audit1').auditCommitHash = 'b'.repeat(40)
    const rendered = formatAuditLogViolations(diff(base, next).violations)

    expect(rendered).toContain('audit1')
    expect(rendered).toContain('auditCommitHash')
    expect(rendered).toContain('a'.repeat(40))
    expect(rendered).toContain('b'.repeat(40))
  })

  it('renders nothing for an empty violation list', () => {
    expect(formatAuditLogViolations([])).toBe('')
  })
})
