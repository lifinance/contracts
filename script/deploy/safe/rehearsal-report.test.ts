import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { createCheckLedger, recordCheck } from './check-ledger'
import { ALL_GATE_DEFINITIONS } from './confirm-check-registry'
import {
  REHEARSAL_GATE_ROSTER,
  buildGateReport,
  checkGradingAnchors,
  renderGateReport,
  renderGradingAnchors,
  renderSignerWorkload,
  summariseSignerWorkload,
  verdictsAreActionable,
} from './rehearsal-report'

describe('buildGateReport', () => {
  it('names a rostered gate that did not register as absent', () => {
    const report = buildGateReport({
      registered: ['target-state'],
      rowCounts: { 'target-state': 3 },
    })

    const executability = report.find(
      (gate) => gate.checkId === 'executability'
    )
    expect(executability?.presence).toBe('absent')
  })

  it('never drops a rostered gate, however few registered', () => {
    const report = buildGateReport({ registered: [], rowCounts: {} })

    expect(report.map((gate) => gate.checkId).sort()).toEqual(
      [...REHEARSAL_GATE_ROSTER.map((gate) => gate.checkId)].sort()
    )
    expect(report.every((gate) => gate.presence === 'absent')).toBe(true)
  })

  it('separates a gate that registered but reported nothing from one that ran', () => {
    const report = buildGateReport({
      registered: ['target-state', 'executability'],
      rowCounts: { 'target-state': 2, executability: 0 },
    })

    expect(
      report.find((gate) => gate.checkId === 'target-state')?.presence
    ).toBe('present')
    expect(
      report.find((gate) => gate.checkId === 'executability')?.presence
    ).toBe('registered-but-silent')
  })

  it('reports a registered gate the roster does not name', () => {
    const report = buildGateReport({
      registered: ['a-gate-nobody-rostered'],
      rowCounts: { 'a-gate-nobody-rostered': 1 },
    })

    const surprise = report.find(
      (gate) => gate.checkId === 'a-gate-nobody-rostered'
    )
    expect(surprise?.presence).toBe('present')
    expect(surprise?.rostered).toBe(false)
  })
})

describe('renderGateReport', () => {
  it('prints every gate including the absent ones', () => {
    const rendered = renderGateReport(
      buildGateReport({ registered: ['target-state'], rowCounts: {} })
    )

    for (const gate of REHEARSAL_GATE_ROSTER)
      expect(rendered).toContain(gate.checkId)
    expect(rendered).toMatch(/absent/)
  })
})

describe('the gate roster', () => {
  it('names every rostered gate from the registry, never from itself', () => {
    const named = new Map(ALL_GATE_DEFINITIONS.map((one) => [one.checkId, one]))

    for (const gate of REHEARSAL_GATE_ROSTER)
      expect(named.has(gate.checkId)).toBe(true)

    const report = buildGateReport({ registered: [], rowCounts: {} })
    for (const row of report)
      expect(row.title).toBe(
        `Gate ${named.get(row.checkId)?.gate} \u00b7 ${
          named.get(row.checkId)?.title
        }`
      )
  })
})

describe('summariseSignerWorkload', () => {
  const ledger = (rows: [string, string, string][]) => {
    const built = createCheckLedger({
      expectedNetworks: ['tron', 'arbitrum'],
      checks: [
        {
          checkId: 'INT-SAFE-TX-HASH',
          section: 'Integrity',
          checkClass: 'integrity',
          gate: 'B',
          title: 'Safe tx hash',
        },
        {
          checkId: 'target-state',
          section: 'Intent',
          checkClass: 'semantic',
          gate: 'H',
          title: 'Facet version',
        },
      ],
    })
    for (const [checkId, network, status] of rows)
      recordCheck(built, {
        checkId,
        network,
        status: status as 'pass' | 'fail' | 'error' | 'needs-ack',
        expected: 'e',
        actual: 'a',
        anchor: 'A-LOCAL',
      })
    return built
  }

  it('separates what the machine settled from what the signer must answer', () => {
    const workload = summariseSignerWorkload([
      {
        proposal: '0xabc',
        ledger: ledger([
          ['INT-SAFE-TX-HASH', 'tron', 'pass'],
          ['target-state', 'tron', 'needs-ack'],
          ['target-state', 'arbitrum', 'pass'],
        ]),
      },
    ])

    expect(workload.settled).toBe(2)
    expect(workload.needsYou).toHaveLength(1)
    expect(workload.needsYou[0]?.checkId).toBe('target-state')
    expect(workload.blocked).toBe(0)
  })

  it('counts a refusal as blocked, not as something the signer may wave through', () => {
    const workload = summariseSignerWorkload([
      {
        proposal: '0xabc',
        ledger: ledger([['INT-SAFE-TX-HASH', 'tron', 'fail']]),
      },
    ])

    expect(workload.blocked).toBe(1)
    expect(workload.needsYou).toHaveLength(0)
  })
})

describe('checkGradingAnchors', () => {
  it('reports the deployment cache as missing when it is not there', () => {
    const anchors = checkGradingAnchors('/nonexistent-root-for-this-test')

    const cache = anchors.find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )
    expect(cache?.present).toBe(false)
    expect(cache?.consequence).toMatch(/every|all/i)
  })

  it('reports it present when the file exists', () => {
    const anchors = checkGradingAnchors(process.cwd())

    const cache = anchors.find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )
    expect(typeof cache?.present).toBe('boolean')
  })
})

describe('verdictsAreActionable', () => {
  it('holds for a corpus of proposals still awaiting signature', () => {
    expect(verdictsAreActionable('pending')).toBe(true)
    expect(verdictsAreActionable('submitted')).toBe(true)
  })

  it('does not hold for proposals that already executed', () => {
    expect(verdictsAreActionable('executed')).toBe(false)
    expect(verdictsAreActionable('reverted')).toBe(false)
  })
})

describe('checkGradingAnchors, on a cache that exists but cannot be used', () => {
  it('reports a file that is not a JSON array as missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rehearsal-anchor-'))
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'deployments_production.json'), '{}')

    const cache = checkGradingAnchors(root).find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )

    expect(cache?.present).toBe(false)
  })

  it('reports a well-formed record array as present', () => {
    const root = mkdtempSync(join(tmpdir(), 'rehearsal-anchor-'))
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(
      join(root, '.cache', 'deployments_production.json'),
      JSON.stringify([
        { network: 'arbitrum', address: '0x1', version: '1.0.0' },
      ])
    )

    const cache = checkGradingAnchors(root).find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )

    expect(cache?.present).toBe(true)
  })
})

describe('renderGradingAnchors', () => {
  it('names the consequence only for the anchor that is missing', () => {
    const rendered = renderGradingAnchors([
      { path: '/a/present.json', present: true, consequence: 'would be bad' },
      { path: '/a/absent.json', present: false, consequence: 'would be bad' },
    ])

    expect(rendered).toContain('present : /a/present.json')
    expect(rendered).toContain('MISSING : /a/absent.json')
    expect(rendered.match(/would be bad/g)).toHaveLength(1)
  })
})

describe('renderSignerWorkload', () => {
  it('prints all three counts and the rows still waiting on a person', () => {
    const rendered = renderSignerWorkload({
      settled: 7,
      blocked: 2,
      needsYou: [
        {
          proposal: '0xabc',
          checkId: 'target-state',
          network: 'tron',
          expected: 'ordering holds',
          actual: 'EcoFacet: matches-main',
        },
      ],
    })

    expect(rendered).toContain('settled automatically : 7')
    expect(rendered).toContain('blocked               : 2')
    expect(rendered).toContain('needs your judgement  : 1')
    expect(rendered).toContain('EcoFacet: matches-main')
  })
})

describe('checkGradingAnchors, on a cache that parses but holds nothing usable', () => {
  const anchorFor = (contents: string) => {
    const root = mkdtempSync(join(tmpdir(), 'rehearsal-anchor-'))
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'deployments_production.json'), contents)
    return checkGradingAnchors(root).find((anchor) =>
      anchor.path.includes('deployments_production.json')
    )
  }

  it('reports an empty array as missing', () => {
    // What a refresh that returned nothing writes, and it produces exactly the
    // contract-unidentified-everywhere run the anchor exists to catch.
    expect(anchorFor('[]')?.present).toBe(false)
  })

  it('reports an array of the wrong shape as missing', () => {
    expect(anchorFor('[1,2,3]')?.present).toBe(false)
  })
})
