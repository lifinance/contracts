import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  type ICheckLedger,
} from './check-ledger'
import {
  collectRefusalObservations,
  comparePasses,
  gradeCorruptionProbe,
  summariseRehearsal,
} from './rehearsal-run'

const ledgerWith = (
  status: 'pass' | 'fail' | 'error' | 'needs-ack',
  actual: string
): ICheckLedger => {
  const ledger = createCheckLedger({
    expectedNetworks: ['tron'],
    checks: [
      {
        checkId: 'target-state',
        section: 'Intent',
        checkClass: 'semantic',
        title: 'Facet version matches the declared target state',
      },
    ],
  })
  recordCheck(ledger, {
    checkId: 'target-state',
    network: 'tron',
    status,
    expected: 'no installed version behind what origin/main declares',
    actual,
    anchor: 'A-LOCAL',
  })
  return ledger
}

describe('comparePasses', () => {
  it('finds nothing when two passes graded identically', () => {
    const findings = comparePasses(
      [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
      [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }]
    )

    expect(findings).toEqual([])
  })

  it('reports a status that changed between passes', () => {
    const findings = comparePasses(
      [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
      [{ proposal: '0xabc', ledger: ledgerWith('error', '1.0.0') }]
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.field).toBe('status')
    expect(findings[0]?.first).toBe('pass')
    expect(findings[0]?.second).toBe('error')
  })

  it('reports an observed value that changed while the status held', () => {
    const findings = comparePasses(
      [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
      [{ proposal: '0xabc', ledger: ledgerWith('pass', '2.0.0') }]
    )

    expect(findings.map((finding) => finding.field)).toEqual(['actual'])
  })

  it('reports a proposal one pass graded and the other did not', () => {
    const findings = comparePasses(
      [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
      []
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.field).toBe('proposal')
  })
})

describe('collectRefusalObservations', () => {
  it('marks a refusing row as refused and carries its reason', () => {
    const observations = collectRefusalObservations([
      { proposal: '0xabc', ledger: ledgerWith('fail', 'downgrade') },
    ])

    expect(observations).toHaveLength(1)
    expect(observations[0]?.refused).toBe(true)
    expect(observations[0]?.slot).toBe('0xabc/target-state/tron')
    expect(observations[0]?.reason).toContain('downgrade')
  })

  it('does not count a passing row as a refusal', () => {
    const observations = collectRefusalObservations([
      { proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') },
    ])

    expect(observations[0]?.refused).toBe(false)
  })

  it('counts a needs-ack row as a refusal a signer must answer', () => {
    const observations = collectRefusalObservations([
      { proposal: '0xabc', ledger: ledgerWith('needs-ack', '1.0.0') },
    ])

    expect(observations[0]?.refused).toBe(true)
  })
})

describe('summariseRehearsal', () => {
  it('refuses to call a run over nothing deterministic', () => {
    const summary = summariseRehearsal({ first: [], second: [] })

    expect(summary.rowsGraded).toBe(0)
    expect(summary.deterministic).toBeUndefined()
    expect(summary.verdict).toBe('not-measured')
  })

  it('calls two agreeing passes over real rows deterministic', () => {
    const summary = summariseRehearsal({
      first: [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
      second: [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
    })

    expect(summary.rowsGraded).toBe(1)
    expect(summary.deterministic).toBe(true)
    expect(summary.verdict).toBe('deterministic')
  })

  it('reports disagreement rather than determinism', () => {
    const summary = summariseRehearsal({
      first: [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
      second: [{ proposal: '0xabc', ledger: ledgerWith('fail', '1.0.0') }],
    })

    expect(summary.deterministic).toBe(false)
    expect(summary.verdict).toBe('non-deterministic')
    expect(summary.findings).toHaveLength(1)
  })
})

describe('gradeCorruptionProbe', () => {
  it('says nothing was exercised when there was nothing to corrupt', () => {
    expect(gradeCorruptionProbe([])).toBe('not-exercised')
  })

  it('passes when the damaged input drew a refusal', () => {
    expect(
      gradeCorruptionProbe([
        { proposal: '0xabc', ledger: ledgerWith('fail', 'corrupted') },
      ])
    ).toBe('refused')
  })

  it('fails when damaged input was graded clean', () => {
    expect(
      gradeCorruptionProbe([
        { proposal: '0xabc', ledger: ledgerWith('pass', 'corrupted') },
      ])
    ).toBe('did-not-refuse')
  })
})

describe('collectRefusalObservations, classifying a known-correct refusal', () => {
  it('marks an unresolved deployment record as a true positive', () => {
    const observations = collectRefusalObservations([
      {
        proposal: '0xabc',
        ledger: ledgerWith('error', '0xfee: contract-unidentified'),
      },
    ])

    expect(observations[0]?.truePositive).toBe(true)
  })

  it('leaves an unrecognised refusal unexplained', () => {
    const observations = collectRefusalObservations([
      { proposal: '0xabc', ledger: ledgerWith('fail', 'downgrade') },
    ])

    expect(observations[0]?.truePositive).toBeUndefined()
  })
})
