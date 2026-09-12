import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { createCheckLedger, recordCheck } from './check-ledger'
import {
  REHEARSAL_GATE_ROSTER,
  buildGateReport,
  checkGradingAnchors,
  renderGateReport,
  summariseSignerWorkload,
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

describe('summariseSignerWorkload', () => {
  const ledger = (rows: [string, string, string][]) => {
    const built = createCheckLedger({
      expectedNetworks: ['tron', 'arbitrum'],
      checks: [
        {
          checkId: 'INT-SAFE-TX-HASH',
          section: 'Integrity',
          checkClass: 'integrity',
          title: 'Recomputed safeTxHash matches the stored one',
        },
        {
          checkId: 'target-state',
          section: 'Intent',
          checkClass: 'semantic',
          title: 'Facet version matches the declared target state',
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
