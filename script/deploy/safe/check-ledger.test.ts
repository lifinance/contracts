import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  buildReviewAttestation,
  createCheckLedger,
  isTriageRelaxationAllowed,
  recordCheck,
  rollUpChecks,
  summariseLedger,
  type ICheckDefinition,
  type ICheckResult,
  type ICheckLedger,
} from './check-ledger'

const CODEHASH: ICheckDefinition = {
  checkId: 'codehash',
  section: 'Integrity',
  checkClass: 'integrity',
  title: 'Deployed codehash matches the attested build',
}

const TARGET_STATE: ICheckDefinition = {
  checkId: 'target-state',
  section: 'Intent',
  checkClass: 'semantic',
  title: 'Facet version matches the declared target state',
}

const ledgerOf = (
  networks: string[],
  checks: ICheckDefinition[] = [CODEHASH, TARGET_STATE]
): ICheckLedger => createCheckLedger({ expectedNetworks: networks, checks })

const result = (over: Partial<ICheckResult> = {}): ICheckResult => ({
  checkId: 'codehash',
  network: 'mainnet',
  status: 'pass',
  expected: '0xaaa',
  actual: '0xaaa',
  anchor: 'A-CI',
  ...over,
})

describe('recordCheck', () => {
  it('keeps pass, fail and error as three distinct recorded states', () => {
    const ledger = ledgerOf(['mainnet', 'polygon', 'arbitrum'])

    recordCheck(ledger, result({ network: 'mainnet', status: 'pass' }))
    recordCheck(
      ledger,
      result({ network: 'polygon', status: 'fail', actual: '0xbbb' })
    )
    recordCheck(
      ledger,
      result({
        network: 'arbitrum',
        status: 'error',
        actual: 'unread',
        anchor: 'A-UNRESOLVED',
        detail: 'RPC timeout',
      })
    )

    expect(ledger.results.map((entry) => entry.status)).toEqual([
      'pass',
      'fail',
      'error',
    ])
  })

  it('rejects a result for a check that was never registered', () => {
    const ledger = ledgerOf(['mainnet'])

    expect(() => recordCheck(ledger, result({ checkId: 'invented' }))).toThrow(
      /not registered/
    )
  })

  it('rejects a result for a network outside the declared denominator', () => {
    const ledger = ledgerOf(['mainnet'])

    expect(() => recordCheck(ledger, result({ network: 'polygon' }))).toThrow(
      /not among the expected networks/
    )
  })

  it('stores a pass that came from an authoritative anchor', () => {
    const ledger = ledgerOf(['mainnet'])

    const stored = recordCheck(ledger, result({ anchor: 'A-CI' }))

    expect(stored.status).toBe('pass')
    expect(stored.anchor).toBe('A-CI')
  })

  it('refuses to let a non-authoritative anchor produce a pass', () => {
    const ledger = ledgerOf(['mainnet', 'polygon', 'arbitrum'])

    const fromMongo = recordCheck(
      ledger,
      result({ network: 'mainnet', anchor: 'A-MONGO' })
    )
    const fromProposal = recordCheck(
      ledger,
      result({ network: 'polygon', anchor: 'A-PROPOSAL' })
    )
    const fromNothing = recordCheck(
      ledger,
      result({ network: 'arbitrum', anchor: 'A-UNRESOLVED' })
    )

    for (const stored of [fromMongo, fromProposal, fromNothing]) {
      expect(stored.status).toBe('error')
      expect(stored.detail).toMatch(/cannot decide a pass/)
    }
  })

  it('leaves a non-pass from a non-authoritative anchor as recorded', () => {
    const ledger = ledgerOf(['mainnet'])

    const stored = recordCheck(
      ledger,
      result({ status: 'fail', anchor: 'A-MONGO', actual: '0xbbb' })
    )

    expect(stored.status).toBe('fail')
    expect(stored.detail).toBeUndefined()
  })

  it('gives an integrity check no acknowledgement path', () => {
    const ledger = ledgerOf(['mainnet'])

    const stored = recordCheck(ledger, result({ status: 'needs-ack' }))

    expect(stored.status).toBe('fail')
    expect(stored.detail).toMatch(/no acknowledgement path/)
  })

  it('keeps needs-ack on a semantic check', () => {
    const ledger = ledgerOf(['mainnet'])

    const stored = recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'needs-ack' })
    )

    expect(stored.status).toBe('needs-ack')
  })

  it('keeps the last result recorded for one check on one network', () => {
    const ledger = ledgerOf(['mainnet'])

    recordCheck(ledger, result({ status: 'error', anchor: 'A-UNRESOLVED' }))
    recordCheck(ledger, result({ status: 'pass' }))

    const rollup = rollUpChecks(ledger).find((r) => r.checkId === 'codehash')
    expect(rollup?.passed).toBe(1)
    expect(rollup?.errored).toBe(0)
  })
})

describe('rollUpChecks', () => {
  it('reports a 56-of-57 as not green, with the shortfall counted', () => {
    const networks = Array.from({ length: 57 }, (_, i) => `net${i}`)
    const ledger = ledgerOf(networks, [CODEHASH])

    for (const network of networks.slice(0, 56))
      recordCheck(ledger, result({ network }))

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.passed).toBe(56)
    expect(rollup?.expected).toBe(57)
    expect(rollup?.missing).toBe(1)
    expect(rollup?.unverified).toBe(1)
    expect(rollup?.green).toBe(false)
  })

  it('reports green only when every expected network passed', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])

    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.green).toBe(true)
    expect(rollup?.passed).toBe(2)
    expect(rollup?.missing).toBe(0)
    expect(rollup?.anchors).toEqual(['A-CI'])
  })

  it('names every anchor a check drew on, so a mixed-anchor green is visible', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])

    recordCheck(ledger, result({ network: 'mainnet', anchor: 'A-CI' }))
    recordCheck(ledger, result({ network: 'polygon', anchor: 'A-LOCAL' }))

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.anchors).toEqual(['A-CI', 'A-LOCAL'])
  })

  it('rolls up a registered check that reported nothing at all', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.expected).toBe(1)
    expect(rollup?.missing).toBe(1)
    expect(rollup?.green).toBe(false)
    expect(rollup?.missingNetworks).toEqual(['mainnet'])
  })

  it('preserves the registration order of the checks', () => {
    const ledger = ledgerOf(['mainnet'])

    expect(rollUpChecks(ledger).map((r) => r.checkId)).toEqual([
      'codehash',
      'target-state',
    ])
  })
})

describe('summariseLedger', () => {
  it('clears a ledger whose every check passed on every network', () => {
    const ledger = ledgerOf(['mainnet'])

    recordCheck(ledger, result())
    recordCheck(ledger, result({ checkId: 'target-state' }))

    const verdict = summariseLedger(ledger)

    expect(verdict.hardBlocked).toBe(false)
    expect(verdict.blocking).toEqual([])
    expect(verdict.requiresAcknowledgement).toEqual([])
  })

  it('hard-blocks an integrity FAIL with no acknowledgement offered', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

    const verdict = summariseLedger(ledger)

    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.blocking).toHaveLength(1)
    expect(verdict.blocking[0]?.reason).toMatch(/integrity/)
    expect(verdict.requiresAcknowledgement).toEqual([])
  })

  it('hard-blocks an ERROR exactly like a FAIL, on either class', () => {
    for (const check of [CODEHASH, TARGET_STATE]) {
      const ledger = ledgerOf(['mainnet'], [check])

      recordCheck(
        ledger,
        result({
          checkId: check.checkId,
          status: 'error',
          anchor: 'A-UNRESOLVED',
          detail: 'RPC timeout',
        })
      )

      const verdict = summariseLedger(ledger)

      expect(verdict.hardBlocked).toBe(true)
      expect(verdict.blocking[0]?.reason).toMatch(/could not run/)
      expect(verdict.requiresAcknowledgement).toEqual([])
    }
  })

  it('hard-blocks a check that never reported on a network', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])

    recordCheck(ledger, result({ network: 'mainnet' }))

    const verdict = summariseLedger(ledger)

    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.blocking).toHaveLength(1)
    expect(verdict.blocking[0]?.network).toBe('polygon')
    expect(verdict.blocking[0]?.reason).toMatch(/no result/)
  })

  it('routes a semantic FAIL to acknowledgement rather than a hard block', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
    )

    const verdict = summariseLedger(ledger)

    expect(verdict.hardBlocked).toBe(false)
    expect(verdict.requiresAcknowledgement).toHaveLength(1)
    expect(verdict.requiresAcknowledgement[0]?.checkId).toBe('target-state')
  })

  it('counts every state in the totals', () => {
    const ledger = ledgerOf(['mainnet', 'polygon', 'arbitrum'], [CODEHASH])

    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(
      ledger,
      result({ network: 'polygon', status: 'fail', actual: '0xbbb' })
    )

    expect(summariseLedger(ledger).totals).toEqual({
      pass: 1,
      fail: 1,
      error: 0,
      needsAck: 0,
      missing: 1,
    })
  })
})

describe('isTriageRelaxationAllowed', () => {
  it('allows a semantic relaxation on a purely subtractive op', () => {
    expect(
      isTriageRelaxationAllowed({
        profile: 'subtractive',
        checkClass: 'semantic',
      })
    ).toEqual({ allowed: true, reason: 'subtractive op, semantic check' })
  })

  it('refuses to relax an integrity check even on a subtractive op', () => {
    const decision = isTriageRelaxationAllowed({
      profile: 'subtractive',
      checkClass: 'integrity',
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/integrity/)
  })

  it('refuses every relaxation on an additive, mixed or unknown op', () => {
    for (const profile of ['additive', 'mixed', 'unknown'] as const) {
      const decision = isTriageRelaxationAllowed({
        profile,
        checkClass: 'semantic',
      })

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toMatch(/subtractive/)
    }
  })
})

describe('summariseLedger under --triage', () => {
  it('drops a semantic acknowledgement on a subtractive op', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
    )

    const verdict = summariseLedger(ledger, { triageProfile: 'subtractive' })

    expect(verdict.requiresAcknowledgement).toEqual([])
    expect(verdict.relaxed).toHaveLength(1)
    expect(verdict.hardBlocked).toBe(false)
  })

  it('keeps the semantic acknowledgement on an additive op', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
    )

    const verdict = summariseLedger(ledger, { triageProfile: 'additive' })

    expect(verdict.requiresAcknowledgement).toHaveLength(1)
    expect(verdict.relaxed).toEqual([])
  })

  it('never relaxes the codehash gate, on any profile', () => {
    for (const triageProfile of [
      'subtractive',
      'additive',
      'mixed',
      'unknown',
    ] as const) {
      const ledger = ledgerOf(['mainnet'], [CODEHASH])

      recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))

      const verdict = summariseLedger(ledger, { triageProfile })

      expect(verdict.hardBlocked).toBe(true)
      expect(verdict.relaxed).toEqual([])
    }
  })

  it('never relaxes an ERROR, on any profile', () => {
    for (const triageProfile of ['subtractive', 'additive'] as const) {
      const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

      recordCheck(
        ledger,
        result({
          checkId: 'target-state',
          status: 'error',
          anchor: 'A-UNRESOLVED',
          detail: 'store unreachable',
        })
      )

      const verdict = summariseLedger(ledger, { triageProfile })

      expect(verdict.hardBlocked).toBe(true)
      expect(verdict.relaxed).toEqual([])
    }
  })

  it('never relaxes a coverage gap, on any profile', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

    const verdict = summariseLedger(ledger, { triageProfile: 'subtractive' })

    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.relaxed).toEqual([])
  })
})

describe('buildReviewAttestation', () => {
  const attest = (ledger: ICheckLedger) =>
    buildReviewAttestation(ledger, {
      reviewer: 'signer-1',
      reviewedAt: '2026-09-08T00:00:00.000Z',
    })

  it('records the verdict, the counts and the reviewer', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])

    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(
      ledger,
      result({ network: 'polygon', status: 'fail', actual: '0xbbb' })
    )

    const attestation = attest(ledger)

    expect(attestation.reviewer).toBe('signer-1')
    expect(attestation.reviewedAt).toBe('2026-09-08T00:00:00.000Z')
    expect(attestation.hardBlocked).toBe(true)
    expect(attestation.checks).toEqual([
      {
        checkId: 'codehash',
        expected: 2,
        passed: 1,
        unverified: 0,
        green: false,
        anchors: ['A-CI'],
      },
    ])
  })

  it('digests the results, not the order they were recorded in', () => {
    const forward = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(forward, result({ network: 'mainnet' }))
    recordCheck(forward, result({ network: 'polygon' }))

    const reverse = ledgerOf(['polygon', 'mainnet'], [CODEHASH])
    recordCheck(reverse, result({ network: 'polygon' }))
    recordCheck(reverse, result({ network: 'mainnet' }))

    expect(attest(forward).ledgerDigest).toBe(attest(reverse).ledgerDigest)
  })

  it('changes the digest when any recorded actual value changes', () => {
    const original = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(original, result())

    const tampered = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(tampered, result({ actual: '0xaab', status: 'fail' }))

    expect(attest(tampered).ledgerDigest).not.toBe(
      attest(original).ledgerDigest
    )
  })

  it('changes the digest when only the anchor differs', () => {
    const fromCi = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(fromCi, result({ anchor: 'A-CI' }))

    const fromLocal = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(fromLocal, result({ anchor: 'A-LOCAL' }))

    expect(attest(fromLocal).ledgerDigest).not.toBe(attest(fromCi).ledgerDigest)
  })

  it('changes the digest when a network stops reporting', () => {
    const complete = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(complete, result({ network: 'mainnet' }))
    recordCheck(complete, result({ network: 'polygon' }))

    const partial = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(partial, result({ network: 'mainnet' }))

    expect(attest(partial).ledgerDigest).not.toBe(attest(complete).ledgerDigest)
  })
})

describe('createCheckLedger', () => {
  it('refuses a ledger with no expected networks, which would be green at 0/0', () => {
    expect(() => ledgerOf([])).toThrow(/expectedNetworks is empty/)
  })

  it('refuses a ledger with no registered checks', () => {
    expect(() => ledgerOf(['mainnet'], [])).toThrow(/no checks registered/)
  })

  it('refuses two checks sharing an id, which would hide one of them', () => {
    expect(() => ledgerOf(['mainnet'], [CODEHASH, CODEHASH])).toThrow(
      /duplicate checkId/
    )
  })

  it('dedupes and normalises the declared networks', () => {
    const ledger = ledgerOf([' Mainnet ', 'mainnet'], [CODEHASH])

    expect(ledger.expectedNetworks).toEqual(['mainnet'])
    expect(rollUpChecks(ledger)[0]?.expected).toBe(1)
  })
})
