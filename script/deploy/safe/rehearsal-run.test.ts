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
  rowCountsByCheck,
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
  const entry = (
    status: 'pass' | 'fail' | 'error' | 'needs-ack',
    actual: string
  ) => [{ proposal: '0xabc', ledger: ledgerWith(status, actual) }]

  it('says nothing was exercised when no row passed before corruption', () => {
    // Every row already refused, so damaging them proves nothing.
    expect(
      gradeCorruptionProbe(entry('fail', 'downgrade'), entry('fail', 'damaged'))
    ).toBe('not-exercised')
  })

  it('passes only when a row that was clean now refuses', () => {
    expect(
      gradeCorruptionProbe(entry('pass', '1.0.0'), entry('fail', 'damaged'))
    ).toBe('refused')
  })

  it('fails when a row that was clean is still clean after corruption', () => {
    expect(
      gradeCorruptionProbe(
        entry('pass', '1.0.0'),
        entry('pass', 'no-diamond-cut')
      )
    ).toBe('did-not-refuse')
  })

  it('does not let an already-refusing row vouch for a row it did not damage', () => {
    const baseline = [
      { proposal: '0xclean', ledger: ledgerWith('pass', '1.0.0') },
      { proposal: '0xdirty', ledger: ledgerWith('fail', 'downgrade') },
    ]
    const corrupted = [
      // The clean row survived corruption untouched...
      { proposal: '0xclean', ledger: ledgerWith('pass', 'no-diamond-cut') },
      // ...while the row that already refused still refuses.
      { proposal: '0xdirty', ledger: ledgerWith('fail', 'downgrade') },
    ]

    expect(gradeCorruptionProbe(baseline, corrupted)).toBe('did-not-refuse')
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

describe('comparePasses, when the second pass records a row the first lacks', () => {
  /** A two-network ledger, so one pass can answer for a network the other did not. */
  const twoNetworkLedger = (networks: readonly string[]): ICheckLedger => {
    const ledger = createCheckLedger({
      expectedNetworks: ['tron', 'arbitrum'],
      checks: [
        {
          checkId: 'target-state',
          section: 'Intent',
          checkClass: 'semantic',
          title: 'Facet version matches the declared target state',
        },
      ],
    })
    for (const network of networks)
      recordCheck(ledger, {
        checkId: 'target-state',
        network,
        status: 'pass',
        expected: 'no installed version behind what origin/main declares',
        actual: '1.0.0',
        anchor: 'A-LOCAL',
      })
    return ledger
  }

  it('reports it instead of grading the run deterministic', () => {
    const summary = summariseRehearsal({
      first: [{ proposal: '0xabc', ledger: twoNetworkLedger(['tron']) }],
      second: [
        { proposal: '0xabc', ledger: twoNetworkLedger(['tron', 'arbitrum']) },
      ],
    })

    expect(summary.verdict).toBe('non-deterministic')
    expect(
      summary.findings.some((finding) => finding.network === 'arbitrum')
    ).toBe(true)
  })
})

describe('rowCountsByCheck', () => {
  it('counts each check once per network, not once per append-log entry', () => {
    const ledger = ledgerWith('pass', '1.0.0')
    recordCheck(ledger, {
      checkId: 'target-state',
      network: 'tron',
      status: 'fail',
      expected: 'no installed version behind what origin/main declares',
      actual: 'downgrade',
      anchor: 'A-MAIN',
    })

    expect(rowCountsByCheck([{ proposal: '0xabc', ledger }])).toEqual({
      'target-state': 1,
    })
  })
})

describe('summariseRehearsal, with asymmetric passes', () => {
  it('does not call a run not-measured while it holds a finding', () => {
    const summary = summariseRehearsal({
      first: [],
      second: [{ proposal: '0xabc', ledger: ledgerWith('pass', '1.0.0') }],
    })

    expect(summary.findings).toHaveLength(1)
    expect(summary.verdict).toBe('non-deterministic')
  })
})

describe('collectRefusalObservations, when a cut mixes refusal classes', () => {
  it('does not launder a downgrade sitting beside an unidentified element', () => {
    const observations = collectRefusalObservations([
      {
        proposal: '0xabc',
        ledger: ledgerWith(
          'fail',
          'SomeLib: contract-unidentified; AcrossFacetV3: downgrade'
        ),
      },
    ])

    expect(observations[0]?.refused).toBe(true)
    expect(observations[0]?.truePositive).toBeUndefined()
  })

  it('does not let a contract name carrying the phrase qualify on its name', () => {
    const observations = collectRefusalObservations([
      {
        proposal: '0xabc',
        ledger: ledgerWith('fail', 'contract-unidentified-helper: downgrade'),
      },
    ])

    expect(observations[0]?.truePositive).toBeUndefined()
  })

  it('still accepts a cut whose every element is unidentified', () => {
    const observations = collectRefusalObservations([
      {
        proposal: '0xabc',
        ledger: ledgerWith(
          'error',
          '0xaaa: contract-unidentified; 0xbbb: contract-unidentified'
        ),
      },
    ])

    expect(observations[0]?.truePositive).toBe(true)
  })
})
