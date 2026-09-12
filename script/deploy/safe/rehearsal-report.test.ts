import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  REHEARSAL_GATE_ROSTER,
  buildGateReport,
  renderGateReport,
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
