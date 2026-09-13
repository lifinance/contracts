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
  type OpProfile,
} from './check-ledger'

const CODEHASH: ICheckDefinition = {
  checkId: 'codehash',
  section: 'Integrity',
  checkClass: 'integrity',
  gate: 'X',
  title: 'Deployed codehash',
}

const TARGET_STATE: ICheckDefinition = {
  checkId: 'target-state',
  section: 'Intent',
  checkClass: 'semantic',
  gate: 'Y',
  title: 'Facet version',
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
      notApplicable: 0,
    })
  })
})

describe('isTriageRelaxationAllowed', () => {
  const ledger = ledgerOf(['mainnet'])

  it('allows an outstanding acknowledgement on a purely subtractive op', () => {
    expect(
      isTriageRelaxationAllowed(ledger, {
        checkId: 'target-state',
        status: 'needs-ack',
        profile: 'subtractive',
      })
    ).toEqual({
      allowed: true,
      reason: 'subtractive op, semantic check, acknowledgement outstanding',
    })
  })

  it('refuses to relax an integrity check even on a subtractive op', () => {
    const decision = isTriageRelaxationAllowed(ledger, {
      checkId: 'codehash',
      status: 'needs-ack',
      profile: 'subtractive',
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/integrity/)
  })

  it('takes the check class from the ledger, not from the caller', () => {
    // The codehash gate is registered as integrity; nothing a caller passes can
    // describe it as semantic, so the gate cannot be relaxed by mislabelling it.
    for (const status of ['needs-ack', 'fail'] as const)
      expect(
        isTriageRelaxationAllowed(ledger, {
          checkId: 'codehash',
          status,
          profile: 'subtractive',
        }).allowed
      ).toBe(false)
  })

  it('refuses a check that is not registered on this ledger', () => {
    const decision = isTriageRelaxationAllowed(ledger, {
      checkId: 'invented',
      status: 'needs-ack',
      profile: 'subtractive',
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/not registered/)
  })

  it('refuses every relaxation on an additive, mixed or unknown op', () => {
    for (const profile of ['additive', 'mixed', 'unknown'] as const) {
      const decision = isTriageRelaxationAllowed(ledger, {
        checkId: 'target-state',
        status: 'needs-ack',
        profile,
      })

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toMatch(/subtractive/)
    }
  })

  it('refuses a mismatch — triage drops an acknowledgement, not a disagreement', () => {
    const decision = isTriageRelaxationAllowed(ledger, {
      checkId: 'target-state',
      status: 'fail',
      profile: 'subtractive',
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/not a fail/)
  })
})

describe('summariseLedger under triage', () => {
  it('drops an outstanding semantic acknowledgement on a subtractive op', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
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
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
    )

    const verdict = summariseLedger(ledger, { triageProfile: 'additive' })

    expect(verdict.requiresAcknowledgement).toHaveLength(1)
    expect(verdict.relaxed).toEqual([])
  })

  it('never relaxes a semantic MISMATCH, on any profile', () => {
    for (const triageProfile of [
      'subtractive',
      'additive',
      'mixed',
      'unknown',
    ] as const) {
      const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

      recordCheck(
        ledger,
        result({ checkId: 'target-state', status: 'fail', actual: '1.0.1' })
      )

      const verdict = summariseLedger(ledger, { triageProfile })

      expect(verdict.relaxed).toEqual([])
      expect(verdict.requiresAcknowledgement).toHaveLength(1)
    }
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
    for (const triageProfile of [
      'subtractive',
      'additive',
      'mixed',
      'unknown',
    ] as const) {
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
    for (const triageProfile of [
      'subtractive',
      'additive',
      'mixed',
      'unknown',
    ] as const) {
      const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

      const verdict = summariseLedger(ledger, { triageProfile })

      expect(verdict.hardBlocked).toBe(true)
      expect(verdict.relaxed).toEqual([])
    }
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
    expect(attestation.triageProfile).toBe('none')
    expect(attestation.hardBlocked).toBe(true)
    expect(attestation.checks).toEqual([
      {
        checkId: 'codehash',
        checkClass: 'integrity',
        expected: 2,
        notApplicable: 0,
        passed: 1,
        failed: 1,
        needsAck: 0,
        unverified: 0,
        green: false,
        anchors: ['A-CI'],
      },
    ])
  })

  it('changes the digest when a check is reclassified', () => {
    const asIntegrity = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(asIntegrity, result({ status: 'fail', actual: '0xbbb' }))

    const asSemantic = ledgerOf(
      ['mainnet'],
      [{ ...CODEHASH, checkClass: 'semantic' }]
    )
    recordCheck(asSemantic, result({ status: 'fail', actual: '0xbbb' }))

    // The class is what decides whether the mismatch blocks, so a digest blind
    // to it would let the gate be demoted without moving the record.
    expect(attest(asIntegrity).hardBlocked).toBe(true)
    expect(attest(asSemantic).hardBlocked).toBe(false)
    expect(attest(asSemantic).ledgerDigest).not.toBe(
      attest(asIntegrity).ledgerDigest
    )
  })

  it('changes the digest on reclassification even when nothing blocks', () => {
    // An all-pass ledger holds `hardBlocked` false on both sides, leaving the
    // class as the only difference — the demote-the-gate-without-moving-the-
    // record attack the digest exists to make visible. A case built on a `fail`
    // cannot show it, because the class moves `hardBlocked` too.
    const asIntegrity = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(asIntegrity, result({ status: 'pass' }))

    const asSemantic = ledgerOf(
      ['mainnet'],
      [{ ...CODEHASH, checkClass: 'semantic' }]
    )
    recordCheck(asSemantic, result({ status: 'pass' }))

    expect(attest(asIntegrity).hardBlocked).toBe(attest(asSemantic).hardBlocked)
    expect(attest(asSemantic).ledgerDigest).not.toBe(
      attest(asIntegrity).ledgerDigest
    )
  })

  it('changes the digest when only the triage profile differs', () => {
    // Two profiles that both leave the needs-ack unrelaxed, so the
    // acknowledgement and relaxed counts and `hardBlocked` are all identical
    // and the profile is the only remaining input.
    const build = () => {
      const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
      recordCheck(
        ledger,
        result({ checkId: 'target-state', status: 'needs-ack' })
      )
      return ledger
    }
    const withProfile = (profile: OpProfile) =>
      buildReviewAttestation(build(), {
        reviewer: 'signer-1',
        reviewedAt: '2026-09-08T00:00:00.000Z',
        triageProfile: profile,
      })

    const unknown = withProfile('unknown')
    const additive = withProfile('additive')

    expect(unknown.hardBlocked).toBe(additive.hardBlocked)
    expect(unknown.ledgerDigest).not.toBe(additive.ledgerDigest)
  })

  it('changes the digest when a check is relabelled', () => {
    // The title is the only text telling a human what is being checked, so
    // renaming it to something harmless has to move the record.
    const original = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(original, result({ status: 'pass' }))

    const relabelled = ledgerOf(
      ['mainnet'],
      [{ ...CODEHASH, title: 'Nothing to see here' }]
    )
    recordCheck(relabelled, result({ status: 'pass' }))

    expect(attest(original).ledgerDigest).not.toBe(
      attest(relabelled).ledgerDigest
    )
  })

  it('changes the digest when triage is what cleared the review', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
    )

    const triaged = buildReviewAttestation(ledger, {
      reviewer: 'signer-1',
      reviewedAt: '2026-09-08T00:00:00.000Z',
      triageProfile: 'subtractive',
    })

    expect(triaged.ledgerDigest).not.toBe(attest(ledger).ledgerDigest)
  })

  it('records the triage profile a clearing review ran under', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'needs-ack',
        actual: 'not targeted on this network',
      })
    )

    const triaged = buildReviewAttestation(ledger, {
      reviewer: 'signer-1',
      reviewedAt: '2026-09-08T00:00:00.000Z',
      triageProfile: 'subtractive',
    })

    expect(triaged.triageProfile).toBe('subtractive')
    expect(triaged.relaxed).toBe(1)
    expect(triaged.awaitingAcknowledgement).toBe(0)

    const untriaged = attest(ledger)
    expect(untriaged.triageProfile).toBe('none')
    expect(untriaged.relaxed).toBe(0)
    expect(untriaged.awaitingAcknowledgement).toBe(1)
  })

  it('digests the recorded detail, not only the values', () => {
    const withDetail = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(
      withDetail,
      result({ status: 'fail', actual: '0xbbb', detail: 'rebuild pending' })
    )

    const withoutDetail = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(withoutDetail, result({ status: 'fail', actual: '0xbbb' }))

    expect(attest(withDetail).ledgerDigest).not.toBe(
      attest(withoutDetail).ledgerDigest
    )
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

  it('changes the digest when only the actual value differs', () => {
    // Status held identical in both, so this observes `actual` alone.
    const original = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(original, result({ status: 'fail', actual: '0xaaa' }))

    const tampered = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(tampered, result({ status: 'fail', actual: '0xaab' }))

    expect(attest(tampered).ledgerDigest).not.toBe(
      attest(original).ledgerDigest
    )
  })

  it('changes the digest when only the status differs', () => {
    const passing = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(passing, result({ status: 'pass', actual: '0xaaa' }))

    const failing = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(failing, result({ status: 'fail', actual: '0xaaa' }))

    expect(attest(failing).ledgerDigest).not.toBe(attest(passing).ledgerDigest)
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

  it('refuses a blank network rather than quietly shrinking the denominator', () => {
    expect(() => ledgerOf(['mainnet', '   ', 'polygon'], [CODEHASH])).toThrow(
      /a declared network is blank/
    )
  })

  it('refuses an id or a network that could forge a key boundary', () => {
    const separator = String.fromCharCode(0)

    expect(() =>
      ledgerOf(['mainnet'], [{ ...CODEHASH, checkId: `code${separator}hash` }])
    ).toThrow(/checkId contains the field separator/)
    expect(() => ledgerOf([`main${separator}net`], [CODEHASH])).toThrow(
      /network contains the field separator/
    )
  })

  it('cannot be made to answer for a pair that never ran', () => {
    // Without the separator check, `c` + sep + `x` + sep + `n` is ambiguous:
    // one recorded result satisfies both (c, x·n) and (c·x, n), so the second
    // pair reads as verified while nothing ran on it.
    const separator = String.fromCharCode(0)

    expect(() =>
      createCheckLedger({
        expectedNetworks: ['n', `x${separator}n`],
        checks: [CODEHASH, { ...CODEHASH, checkId: `codehash${separator}x` }],
      })
    ).toThrow(/field separator/)
  })
})

describe('a result that reached the log without recordCheck', () => {
  it('cannot make a reporting-only anchor decide a pass', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    ledger.results.push({
      checkId: 'codehash',
      network: 'mainnet',
      status: 'pass',
      expected: '0xaaa',
      actual: '0xaaa',
      anchor: 'A-MONGO',
    })

    const [rollup] = rollUpChecks(ledger)
    expect(rollup?.green).toBe(false)
    expect(rollup?.errored).toBe(1)
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  it('cannot make an unrecognised anchor decide a pass', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    ledger.results.push({
      ...result(),
      anchor: 'a-mongo' as ICheckResult['anchor'],
    })

    expect(rollUpChecks(ledger)[0]?.green).toBe(false)
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  it('cannot give an integrity check an acknowledgement path', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    ledger.results.push({ ...result(), status: 'needs-ack' })

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.requiresAcknowledgement).toEqual([])
    expect(verdict.totals).toEqual({
      pass: 0,
      fail: 1,
      error: 0,
      needsAck: 0,
      missing: 0,
      notApplicable: 0,
    })
  })

  it('blocks on a status this ledger does not recognise', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])

    ledger.results.push({
      ...result({ checkId: 'target-state' }),
      status: 'ok' as ICheckResult['status'],
    })

    const verdict = summariseLedger(ledger, { triageProfile: 'subtractive' })
    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.blocking[0]?.reason).toMatch(
      /not one this ledger recognises/
    )
    expect(verdict.relaxed).toEqual([])
    expect(verdict.requiresAcknowledgement).toEqual([])
  })
})

describe('recordCheck rejects a value that bypassed the type', () => {
  it('refuses an unknown status', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    expect(() =>
      recordCheck(ledger, {
        ...result(),
        status: 'ok' as ICheckResult['status'],
      })
    ).toThrow(/unknown status "ok"/)
  })

  it('refuses an unknown anchor', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    expect(() =>
      recordCheck(ledger, {
        ...result(),
        anchor: 'A-CI ' as ICheckResult['anchor'],
      })
    ).toThrow(/unknown anchor/)
  })
})

describe('supersession', () => {
  it('lets a retry clear a result that could not run', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    recordCheck(
      ledger,
      result({ status: 'error', anchor: 'A-UNRESOLVED', detail: 'RPC timeout' })
    )
    recordCheck(ledger, result({ status: 'pass' }))

    const [rollup] = rollUpChecks(ledger)
    expect(rollup?.passed).toBe(1)
    expect(rollup?.errored).toBe(0)
    expect(rollup?.green).toBe(true)
  })

  it('never lets a later pass erase a recorded mismatch', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))
    recordCheck(ledger, result({ status: 'pass' }))

    const [rollup] = rollUpChecks(ledger)
    expect(rollup?.failed).toBe(1)
    expect(rollup?.passed).toBe(0)
    expect(rollup?.green).toBe(false)
    expect(rollup?.results[0]?.actual).toBe('0xbbb')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  it('holds the mismatch even when other results land in between', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))
    recordCheck(ledger, result({ status: 'error', anchor: 'A-UNRESOLVED' }))
    recordCheck(ledger, result({ status: 'pass' }))

    expect(rollUpChecks(ledger)[0]?.green).toBe(false)
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  it('keeps superseding scoped to one check on one network', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'])

    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))
    recordCheck(ledger, result({ network: 'polygon' }))
    recordCheck(ledger, result({ checkId: 'target-state' }))
    recordCheck(ledger, result({ checkId: 'target-state', network: 'polygon' }))

    const [codehash, targetState] = rollUpChecks(ledger)
    expect(codehash?.failed).toBe(1)
    expect(codehash?.passed).toBe(1)
    expect(targetState?.green).toBe(true)
  })
})

describe('nothing that would soften the verdict may erase a mismatch', () => {
  const attest = (ledger: ICheckLedger) =>
    buildReviewAttestation(ledger, {
      reviewer: 'signer-1',
      reviewedAt: '2026-09-08T00:00:00.000Z',
    })

  it('keeps the run hard-blocked when a retry of a mismatch could not run', () => {
    // A mismatch whose retry could not run is not acknowledgeable: `error`
    // blocks with no acknowledgement path, so the run must stay hard-blocked.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'fail', actual: '0xbbb' })
    )
    recordCheck(
      ledger,
      result({
        checkId: 'target-state',
        status: 'error',
        detail: 'rpc unreachable',
      })
    )

    const verdict = summariseLedger(ledger)

    expect(verdict.hardBlocked).toBe(true)
    // Paired with the standalone case, so this cannot pass by blocking
    // everything: an error with no prior mismatch blocks the same way.
    const alone = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      alone,
      result({ checkId: 'target-state', status: 'error', detail: 'rpc down' })
    )
    expect(summariseLedger(alone).hardBlocked).toBe(true)
  })

  it('still lets a retry clear an unverified result', () => {
    // The paired positive for the guard: recording a retryable failure exists
    // so a retry can turn it green, and only a mismatch is protected.
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'error', detail: 'rpc down' })
    )
    recordCheck(ledger, result({ checkId: 'target-state', status: 'pass' }))

    expect(summariseLedger(ledger).hardBlocked).toBe(false)
  })

  it('digests a superseded result, so the record shows what happened', () => {
    // Two runs with the same surviving result and the same verdict, differing
    // only in history, must not share a record.
    const straight = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(straight, result({ status: 'pass' }))

    const retried = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(retried, result({ status: 'error', detail: 'rpc down' }))
    recordCheck(retried, result({ status: 'pass' }))

    // Same surviving result, same verdict — only the history differs.
    expect(attest(retried).hardBlocked).toBe(attest(straight).hardBlocked)
    expect(attest(retried).ledgerDigest).not.toBe(attest(straight).ledgerDigest)
  })

  it('counts an unrecognised status as unverified, not as nothing', () => {
    // A status the verdict grades as unverified has to land in a numerator, or
    // the check line reads `pass 0/1` with no term saying why.
    const rehydrated = {
      expectedNetworks: ['mainnet'],
      checks: new Map([[CODEHASH.checkId, CODEHASH]]),
      results: [
        result({ status: 'verified' as unknown as ICheckResult['status'] }),
      ],
    } as unknown as ICheckLedger

    const [rollup] = rollUpChecks(rehydrated)

    expect(rollup?.errored).toBe(1)
    expect(rollup?.unverified).toBe(1)
  })
})

describe('undecidableIsAcknowledgeable', () => {
  // A gate that reads live state against an expectation the proposer writes can
  // neither decide a green nor honestly refuse: the operator has no way to make
  // a record-sourced expectation into a repo-sourced one. The opt-in gives that
  // one case a signer to answer it, and nothing else.
  const AUTHORITIES: ICheckDefinition = {
    checkId: 'storage-authority',
    section: 'Deployed state',
    checkClass: 'integrity',
    gate: 'Z',
    title: 'Storage authorities',
    undecidableIsAcknowledgeable: true,
  }

  const row = (over: Partial<ICheckResult> = {}): ICheckResult => ({
    checkId: 'storage-authority',
    network: 'mainnet',
    status: 'needs-ack',
    expected: 'the address main declares',
    actual: 'the address main declares',
    anchor: 'A-MONGO',
    ...over,
  })

  const verdictOf = (
    definition: ICheckDefinition,
    over: Partial<ICheckResult> = {}
  ) => {
    const ledger = ledgerOf(['mainnet'], [definition])
    recordCheck(ledger, row(over))
    return summariseLedger(ledger)
  }

  it('keeps needs-ack on an integrity check whose anchor only reports', () => {
    const ledger = ledgerOf(['mainnet'], [AUTHORITIES])

    expect(recordCheck(ledger, row()).status).toBe('needs-ack')

    const verdict = verdictOf(AUTHORITIES)
    expect(verdict.hardBlocked).toBe(false)
    expect(verdict.requiresAcknowledgement).toHaveLength(1)
  })

  it('does nothing without the flag', () => {
    const { undecidableIsAcknowledgeable: _optIn, ...plain } = AUTHORITIES

    expect(verdictOf(plain).hardBlocked).toBe(true)
  })

  it('refuses the exemption on A-UNRESOLVED, where nothing answered', () => {
    const ledger = ledgerOf(['mainnet'], [AUTHORITIES])

    expect(recordCheck(ledger, row({ anchor: 'A-UNRESOLVED' })).status).toBe(
      'fail'
    )
    expect(verdictOf(AUTHORITIES, { anchor: 'A-UNRESOLVED' }).hardBlocked).toBe(
      true
    )
  })

  it('refuses the exemption on an anchor that could have decided', () => {
    // `A-LOCAL` can grade a pass, so a `needs-ack` on it is not an undecidable
    // expectation — it is an integrity check asking to be clicked through.
    expect(verdictOf(AUTHORITIES, { anchor: 'A-LOCAL' }).hardBlocked).toBe(true)
  })

  it('leaves a real mismatch hard-blocking, on the same anchor', () => {
    const verdict = verdictOf(AUTHORITIES, {
      status: 'fail',
      actual: '0xattacker',
    })

    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.requiresAcknowledgement).toHaveLength(0)
  })

  it('is not what reclassifying the check as semantic would do', () => {
    // The measured false green this flag exists to avoid: `semantic` sends the
    // mismatch to acknowledgement too, turning a storage-authority swap into a
    // prompt.
    const asSemantic = verdictOf(
      { ...AUTHORITIES, checkClass: 'semantic' },
      { status: 'fail', actual: '0xattacker' }
    )

    expect(asSemantic.hardBlocked).toBe(false)
    expect(asSemantic.requiresAcknowledgement).toHaveLength(1)
  })

  it('moves the ledger digest, so it cannot be added off the record', () => {
    const { undecidableIsAcknowledgeable: _optIn, ...plain } = AUTHORITIES
    const attest = (definition: ICheckDefinition) => {
      const ledger = ledgerOf(['mainnet'], [definition])
      recordCheck(ledger, row({ status: 'pass', anchor: 'A-CHAIN' }))
      return buildReviewAttestation(ledger, {
        reviewer: 'signer-1',
        reviewedAt: '2026-09-13T00:00:00.000Z',
      }).ledgerDigest
    }

    expect(attest(AUTHORITIES)).not.toBe(attest(plain))
  })
})

describe('a network that had nothing to grade', () => {
  /**
   * The row `confirm-safe-tx.ts` writes for a network it positively established
   * carries no proposal for this signer — a pending proposal the signer has
   * already signed is the case that produced it in production.
   */
  const nothingToGrade = (network: string): Partial<ICheckResult> => ({
    network,
    status: 'not-applicable',
    expected: 'every proposal this run would sign graded before signing',
    actual: `no proposal was graded on ${network} — nothing actionable was left once the network was prepared`,
    anchor: 'A-LOCAL',
  })

  it('is recorded as its own state, not as a pass', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])

    recordCheck(ledger, result(nothingToGrade('mainnet')))

    expect(ledger.results.map((entry) => entry.status)).toEqual([
      'not-applicable',
    ])
  })

  it('satisfies no verified counter', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result(nothingToGrade('mainnet')))

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.passed).toBe(0)
    expect(rollup?.notApplicable).toBe(1)
    // The denominator the verified count is measured against, so `0/0` is what
    // a vacuous check reads as rather than a full house.
    expect(rollup?.graded).toBe(0)
    expect(rollup?.green).toBe(false)
  })

  it('leaves the run unblocked while saying nothing was verified', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result(nothingToGrade('mainnet')))

    const verdict = summariseLedger(ledger)

    // Unblocked because nothing was wrong, and `nothingGraded` because nothing
    // was right either: the two facts a single boolean cannot carry.
    expect(verdict.hardBlocked).toBe(false)
    expect(verdict.nothingGraded).toBe(true)
    expect(verdict.totals.pass).toBe(0)
    expect(verdict.totals.notApplicable).toBe(1)
    expect(verdict.requiresAcknowledgement).toHaveLength(0)
  })

  it('does not suppress the verdict of a run that did grade something', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result({ network: 'polygon' }))

    const verdict = summariseLedger(ledger)
    const [rollup] = rollUpChecks(ledger)

    expect(verdict.nothingGraded).toBe(false)
    expect(verdict.totals.pass).toBe(2)
    expect(verdict.totals.notApplicable).toBe(0)
    expect(rollup?.graded).toBe(2)
    expect(rollup?.green).toBe(true)
  })

  it('measures the graded networks against themselves, not against the fleet', () => {
    const ledger = ledgerOf(['mainnet', 'polygon'], [CODEHASH])
    recordCheck(ledger, result({ network: 'mainnet' }))
    recordCheck(ledger, result(nothingToGrade('polygon')))

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.passed).toBe(1)
    expect(rollup?.graded).toBe(1)
    expect(rollup?.notApplicable).toBe(1)
    // Still the declared denominator, so the shrink is recoverable from the
    // rollup rather than lost.
    expect(rollup?.expected).toBe(2)
    expect(rollup?.green).toBe(true)
    expect(summariseLedger(ledger).nothingGraded).toBe(false)
  })

  it('never erases a mismatch the same network already recorded', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result({ status: 'fail', actual: '0xbbb' }))
    recordCheck(ledger, result(nothingToGrade('mainnet')))

    const [rollup] = rollUpChecks(ledger)
    const verdict = summariseLedger(ledger)

    expect(rollup?.failed).toBe(1)
    expect(rollup?.notApplicable).toBe(0)
    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.nothingGraded).toBe(false)
  })

  it('never erases a result the same network could not grade', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(
      ledger,
      result({ status: 'error', actual: 'unread', detail: 'rpc down' })
    )
    recordCheck(ledger, result(nothingToGrade('mainnet')))

    const [rollup] = rollUpChecks(ledger)
    const verdict = summariseLedger(ledger)

    expect(rollup?.errored).toBe(1)
    expect(rollup?.notApplicable).toBe(0)
    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.totals.error).toBe(1)
  })

  it('never erases an acknowledgement the same network is owed', () => {
    const ledger = ledgerOf(['mainnet'], [TARGET_STATE])
    recordCheck(
      ledger,
      result({ checkId: 'target-state', status: 'needs-ack' })
    )
    recordCheck(
      ledger,
      result({ ...nothingToGrade('mainnet'), checkId: 'target-state' })
    )

    const [rollup] = rollUpChecks(ledger)
    const verdict = summariseLedger(ledger)

    expect(rollup?.needsAck).toBe(1)
    expect(rollup?.notApplicable).toBe(0)
    expect(verdict.requiresAcknowledgement).toHaveLength(1)
    expect(verdict.nothingGraded).toBe(false)
  })

  it('is itself superseded by a result that did grade the network', () => {
    // The paired positive: the guard protects what was graded, so it must not
    // freeze a network the run went on to reach.
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result(nothingToGrade('mainnet')))
    recordCheck(ledger, result({ status: 'pass' }))

    const [rollup] = rollUpChecks(ledger)

    expect(rollup?.passed).toBe(1)
    expect(rollup?.notApplicable).toBe(0)
    expect(rollup?.green).toBe(true)
  })

  it('is recorded in the attestation as a check that went ungraded', () => {
    const ledger = ledgerOf(['mainnet'], [CODEHASH])
    recordCheck(ledger, result(nothingToGrade('mainnet')))

    const [attested] = buildReviewAttestation(ledger, {
      reviewer: '0xsigner',
      reviewedAt: '2026-09-13T00:00:00.000Z',
    }).checks

    expect(attested?.passed).toBe(0)
    expect(attested?.notApplicable).toBe(1)
    expect(attested?.green).toBe(false)
  })
})
