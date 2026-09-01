/**
 * The orchestration layer between the audit log and the content verdict.
 *
 * `verify-audit-content.ts` decides; this module selects the entries to decide
 * over and resolves each one against a tree-ish. Git is injected, so every case
 * below — including the ones that only occur against GitHub — runs in memory.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import type { Hex } from 'viem'

import {
  collectEntriesForContract,
  contractNameFromPath,
  extractContractVersion,
  resolveContractSource,
  runAuditGate,
  type IAuditGateDeps,
} from './audit-gate'
import type { AuditLogEntry, IAuditLogFile } from './audit-log-guard'

const HEAD = `0x${'a'.repeat(64)}` as Hex
const DRIFTED = `0x${'b'.repeat(64)}` as Hex
const AUDIT_SHA = 'c'.repeat(40)
const SECOND_SHA = 'd'.repeat(40)

const FOO = 'src/Facets/FooFacet.sol'

const logWith = (
  audits: IAuditLogFile['audits'],
  auditedContracts: IAuditLogFile['auditedContracts']
): IAuditLogFile => ({ audits, auditedContracts })

const entry = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  auditCompletedOn: '01.01.2026',
  auditedBy: 'Cantina',
  auditorGitHandle: 'someone',
  auditReportPath: './audit/reports/foo.pdf',
  auditCommitHash: AUDIT_SHA,
  ...over,
})

const singleAuditLog = (over: Partial<AuditLogEntry> = {}): IAuditLogFile =>
  logWith({ audit1: entry(over) }, { FooFacet: { '1.0.0': ['audit1'] } })

/** Injected git: a map of `${treeish}:${path}` to whatever git would yield. */
const depsFrom = (
  table: Record<string, Hex | 'unfetchable' | 'contract-absent'>
): IAuditGateDeps => ({
  closureAt: (treeish, path) => table[`${treeish}:${path}`] ?? 'unfetchable',
})

describe('contractNameFromPath', () => {
  it('takes the basename without the .sol extension', () => {
    expect(contractNameFromPath(FOO)).toBe('FooFacet')
  })

  it('is unaffected by directory depth', () => {
    expect(contractNameFromPath('src/Periphery/Deep/Nested/Bar.sol')).toBe(
      'Bar'
    )
  })
})

describe('collectEntriesForContract', () => {
  it('returns the entries logged for that contract at that version', () => {
    const entries = collectEntriesForContract(
      singleAuditLog(),
      'FooFacet',
      '1.0.0'
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.auditId).toBe('audit1')
    expect(entries[0]?.auditCommitHash).toBe(AUDIT_SHA)
  })

  it('returns nothing for a version that is not logged', () => {
    expect(
      collectEntriesForContract(singleAuditLog(), 'FooFacet', '2.0.0')
    ).toHaveLength(0)
  })

  it('returns nothing for a contract that is not logged', () => {
    expect(
      collectEntriesForContract(singleAuditLog(), 'BarFacet', '1.0.0')
    ).toHaveLength(0)
  })

  it('drops an audit id that has no entry in `audits` rather than inventing one', () => {
    const log = logWith(
      {},
      { FooFacet: { '1.0.0': ['audit1', 'audit-missing'] } }
    )

    expect(collectEntriesForContract(log, 'FooFacet', '1.0.0')).toHaveLength(0)
  })

  it('deduplicates a repeated audit id', () => {
    const log = logWith(
      { audit1: entry() },
      { FooFacet: { '1.0.0': ['audit1', 'audit1'] } }
    )

    expect(collectEntriesForContract(log, 'FooFacet', '1.0.0')).toHaveLength(1)
  })

  it('carries a recorded sourceClosureHash through when the entry has one', () => {
    const log = singleAuditLog({ sourceClosureHash: HEAD })

    expect(
      collectEntriesForContract(log, 'FooFacet', '1.0.0')[0]?.sourceClosureHash
    ).toBe(HEAD)
  })
})

describe('runAuditGate', () => {
  it('passes when PR head is byte-identical to the audited commit', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({
        [`HEAD:${FOO}`]: HEAD,
        [`${AUDIT_SHA}:${FOO}`]: HEAD,
      }),
    })

    expect(report.verdict).toBe('pass')
    expect(report.results[0]?.matchedAuditId).toBe('audit1')
  })

  it('F24 — blocks a contract edited after its audit commit inside the same PR', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({
        [`HEAD:${FOO}`]: DRIFTED,
        [`${AUDIT_SHA}:${FOO}`]: HEAD,
      }),
    })

    expect(report.verdict).toBe('fail')
    expect(report.results[0]?.reason).toContain('changed after it was audited')
  })

  it('ERROR-blocks — never falls through — when the audit commit cannot be fetched', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({
        [`HEAD:${FOO}`]: HEAD,
        [`${AUDIT_SHA}:${FOO}`]: 'unfetchable',
      }),
    })

    expect(report.verdict).toBe('error')
    expect(report.blocked).toBe(true)
  })

  it('has no Revert-title exemption — a Revert-titled PR carrying drifted code still blocks', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      prTitle: 'Revert "feat: something else entirely"',
      deps: depsFrom({
        [`HEAD:${FOO}`]: DRIFTED,
        [`${AUDIT_SHA}:${FOO}`]: HEAD,
      }),
    })

    expect(report.verdict).toBe('fail')
  })

  it('a clean revert needs no exemption — restored audited source passes on content', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      prTitle: 'Revert "feat(FooFacet): the change being reverted"',
      deps: depsFrom({
        [`HEAD:${FOO}`]: HEAD,
        [`${AUDIT_SHA}:${FOO}`]: HEAD,
      }),
    })

    expect(report.verdict).toBe('pass')
  })

  it('any single passing audit settles the contract, whatever the others say', () => {
    const log = logWith(
      {
        audit1: entry(),
        audit2: entry({
          auditedBy: 'Sigma Prime',
          auditCommitHash: SECOND_SHA,
        }),
      },
      { FooFacet: { '1.0.0': ['audit1', 'audit2'] } }
    )

    const report = runAuditGate({
      log,
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({
        [`HEAD:${FOO}`]: HEAD,
        [`${AUDIT_SHA}:${FOO}`]: DRIFTED,
        [`${SECOND_SHA}:${FOO}`]: HEAD,
      }),
    })

    expect(report.verdict).toBe('pass')
    expect(report.results[0]?.matchedAuditId).toBe('audit2')
  })

  it('blocks a contract with no audit entry at all', () => {
    const report = runAuditGate({
      log: logWith({}, {}),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({ [`HEAD:${FOO}`]: HEAD }),
    })

    expect(report.verdict).toBe('fail')
    expect(report.results[0]?.reason).toContain('no audit entry found')
  })

  it('ERROR-blocks when PR head itself cannot be read — the gate never assumes', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({ [`HEAD:${FOO}`]: 'contract-absent' }),
    })

    expect(report.verdict).toBe('error')
    expect(report.results[0]?.reason).toContain('at PR head')
  })

  it('D10 — a non-SHA auditCommitHash with no pinned baseline ERROR-blocks', () => {
    const report = runAuditGate({
      log: singleAuditLog({
        auditCommitHash: 'n/a (forked contract audited for Sushiswap)',
      }),
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({ [`HEAD:${FOO}`]: HEAD }),
    })

    expect(report.verdict).toBe('error')
    expect(report.results[0]?.reason).toContain('nothing to compare against')
  })

  it('D10 — a non-SHA auditCommitHash passes against its pinned baseline', () => {
    const log = singleAuditLog({
      auditCommitHash: 'n/a (forked contract audited for Sushiswap)',
      pinnedClosureHash: HEAD,
    })

    const report = runAuditGate({
      log,
      contracts: [{ path: FOO, version: '1.0.0' }],
      headTreeish: 'HEAD',
      deps: depsFrom({ [`HEAD:${FOO}`]: HEAD }),
    })

    expect(report.verdict).toBe('pass')
  })

  it('resolves each audit commit once even when several contracts share it', () => {
    const log = logWith(
      { audit1: entry() },
      {
        FooFacet: { '1.0.0': ['audit1'] },
        BarFacet: { '1.0.0': ['audit1'] },
      }
    )
    const calls: string[] = []
    const table: Record<string, Hex> = {
      [`HEAD:${FOO}`]: HEAD,
      [`${AUDIT_SHA}:${FOO}`]: HEAD,
      ['HEAD:src/Facets/BarFacet.sol']: HEAD,
      [`${AUDIT_SHA}:src/Facets/BarFacet.sol`]: HEAD,
    }

    const report = runAuditGate({
      log,
      contracts: [
        { path: FOO, version: '1.0.0' },
        { path: 'src/Facets/BarFacet.sol', version: '1.0.0' },
      ],
      headTreeish: 'HEAD',
      deps: {
        closureAt: (treeish, path) => {
          calls.push(`${treeish}:${path}`)
          return table[`${treeish}:${path}`] ?? 'unfetchable'
        },
      },
    })

    expect(report.verdict).toBe('pass')
    // one head read + one audit-commit read per contract, no repeats
    expect(calls).toHaveLength(new Set(calls).size)
  })

  it('reports every contract, not just the first failure', () => {
    const log = logWith(
      { audit1: entry() },
      {
        FooFacet: { '1.0.0': ['audit1'] },
        BarFacet: { '1.0.0': ['audit1'] },
      }
    )

    const report = runAuditGate({
      log,
      contracts: [
        { path: FOO, version: '1.0.0' },
        { path: 'src/Facets/BarFacet.sol', version: '1.0.0' },
      ],
      headTreeish: 'HEAD',
      deps: depsFrom({
        [`HEAD:${FOO}`]: HEAD,
        [`${AUDIT_SHA}:${FOO}`]: HEAD,
        ['HEAD:src/Facets/BarFacet.sol']: DRIFTED,
        [`${AUDIT_SHA}:src/Facets/BarFacet.sol`]: HEAD,
      }),
    })

    expect(report.results).toHaveLength(2)
    expect(report.results[0]?.verdict).toBe('pass')
    expect(report.results[1]?.verdict).toBe('fail')
    expect(report.verdict).toBe('fail')
  })

  it('ERROR outranks FAIL across contracts — not knowing is not a mismatch', () => {
    const log = logWith(
      { audit1: entry() },
      {
        FooFacet: { '1.0.0': ['audit1'] },
        BarFacet: { '1.0.0': ['audit1'] },
      }
    )

    const report = runAuditGate({
      log,
      contracts: [
        { path: FOO, version: '1.0.0' },
        { path: 'src/Facets/BarFacet.sol', version: '1.0.0' },
      ],
      headTreeish: 'HEAD',
      deps: depsFrom({
        [`HEAD:${FOO}`]: DRIFTED,
        [`${AUDIT_SHA}:${FOO}`]: HEAD,
        ['HEAD:src/Facets/BarFacet.sol']: HEAD,
        [`${AUDIT_SHA}:src/Facets/BarFacet.sol`]: 'unfetchable',
      }),
    })

    expect(report.verdict).toBe('error')
    expect(report.blocked).toBe(true)
  })

  it('passes with an empty contract list — nothing to audit is not a failure', () => {
    const report = runAuditGate({
      log: singleAuditLog(),
      contracts: [],
      headTreeish: 'HEAD',
      deps: depsFrom({}),
    })

    expect(report.verdict).toBe('pass')
    expect(report.blocked).toBe(false)
  })
})

describe('extractContractVersion', () => {
  it('reads the anchored natspec tag', () => {
    expect(
      extractContractVersion('/// @custom:version 1.2.3\ncontract Foo {}')
    ).toBe('1.2.3')
  })

  it('finds the tag below a licence header and pragma', () => {
    const source = [
      '// SPDX-License-Identifier: LGPL-3.0-only',
      'pragma solidity ^0.8.17;',
      '',
      '/// @title Foo Facet',
      '/// @custom:version 2.0.1',
      'contract FooFacet {}',
    ].join('\n')

    expect(extractContractVersion(source)).toBe('2.0.1')
  })

  it('returns undefined when the tag is absent, rather than guessing a default', () => {
    expect(extractContractVersion('contract Foo {}')).toBeUndefined()
  })

  it('ignores a mention that is not at the start of a line', () => {
    expect(
      extractContractVersion('contract Foo {} // @custom:version 9.9.9')
    ).toBeUndefined()
  })

  it('takes the first declaration when a file somehow carries two', () => {
    expect(
      extractContractVersion(
        '/// @custom:version 1.0.0\n/// @custom:version 2.0.0\n'
      )
    ).toBe('1.0.0')
  })
})

describe('resolveContractSource', () => {
  it('ERRORs when neither argument was supplied, rather than reading as "nothing to check"', () => {
    const resolved = resolveContractSource({})

    expect(resolved.kind).toBe('absent')
  })

  it('accepts an explicitly empty list as a real answer', () => {
    const resolved = resolveContractSource({ contracts: '' })

    expect(resolved).toEqual({ kind: 'provided', raw: '' })
  })

  it('prefers --contracts when both are given', () => {
    const resolved = resolveContractSource({
      contracts: 'src/Facets/FooFacet.sol',
      contractsFile: 'contracts_for_audit.txt',
    })

    expect(resolved).toEqual({
      kind: 'provided',
      raw: 'src/Facets/FooFacet.sol',
    })
  })

  it('reports the file when only --contracts-file is given', () => {
    const resolved = resolveContractSource({
      contractsFile: 'contracts_for_audit.txt',
    })

    expect(resolved).toEqual({
      kind: 'file',
      path: 'contracts_for_audit.txt',
    })
  })
})

describe('entry normalisation', () => {
  const log: IAuditLogFile = {
    audits: {
      audit1: { auditCommitHash: `${'a'.repeat(40)}\n` },
      audit2: {
        auditCommitHash: 'b'.repeat(40),
        sourceClosureHash: `0x${'C'.repeat(64)}`,
      },
    },
    auditedContracts: { FooFacet: { '1.0.0': ['audit1', 'audit2'] } },
  }

  it('trims a stray newline off auditCommitHash so the entry still counts as a commit', () => {
    const [first] = collectEntriesForContract(log, 'FooFacet', '1.0.0')

    expect(first?.auditCommitHash).toBe('a'.repeat(40))
  })

  it('lower-cases a recorded hash, so an uppercase record is not a false mismatch', () => {
    const entries = collectEntriesForContract(log, 'FooFacet', '1.0.0')
    const second = entries.find((entry) => entry.auditId === 'audit2')

    expect(second?.sourceClosureHash).toBe(`0x${'c'.repeat(64)}`)
  })
})
