// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
import {
  deriveGateInput,
  evaluatePreBroadcastGate,
  type IPreBroadcastGateInput,
} from './prebroadcast-rederive'

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'
const STRANGER = '0x00000000000000000000000000000000000000ff'
const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // pre-commit-checker: not a secret — a synthetic test hash

const matchingAuthority = (
  overrides: Partial<IPreBroadcastAuthority> = {}
): IPreBroadcastAuthority => ({
  label: 'LiFiDiamond.owner()',
  liveValue: TIMELOCK,
  expectedValue: TIMELOCK,
  expectationSource: 'deployments',
  readError: undefined,
  ...overrides,
})

const input = (
  overrides: Partial<IPreBroadcastGateInput> = {}
): IPreBroadcastGateInput => ({
  operationId: OP_ID,
  scheduledAt: 1_700_000_000n,
  addressesNamed: 1,
  addressesResolved: 1,
  authorities: [matchingAuthority()],
  signTimeRecordPresent: true,
  ...overrides,
})

describe('evaluatePreBroadcastGate', () => {
  it('proceeds when the timelock holds the operation and every authority matches', () => {
    const result = evaluatePreBroadcastGate(input())
    expect(result.disposition).toBe('PROCEED')
    expect(result.blocksBroadcast).toBe(false)
    expect(result.findings).toEqual([])
  })

  it('blocks when an authority holds an address main does not declare', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [matchingAuthority({ liveValue: STRANGER })],
      })
    )
    expect(result.disposition).toBe('BLOCK')
    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings[0]).toContain(STRANGER)
    expect(result.findings[0]).toContain(TIMELOCK)
  })

  it('holds when an authority could not be read', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [
          matchingAuthority({
            liveValue: undefined,
            readError: 'node unreachable',
          }),
        ],
      })
    )
    expect(result.disposition).toBe('HOLD')
    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings[0]).toContain('node unreachable')
  })

  it('holds rather than passing when main declares no value to judge against', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [matchingAuthority({ expectedValue: undefined })],
      })
    )
    expect(result.disposition).toBe('HOLD')
    expect(result.findings[0]).toContain('declares no expected value')
  })

  it('lets a proven failure decide over a failed read in the same operation', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [
          matchingAuthority({
            label: 'ERC20Proxy.owner()',
            liveValue: undefined,
            readError: 'node unreachable',
          }),
          matchingAuthority({ liveValue: STRANGER }),
        ],
      })
    )
    expect(result.disposition).toBe('BLOCK')
    // Both survive, so the read failure is not hidden by the mismatch.
    expect(result.findings).toHaveLength(2)
  })

  describe('what the timelock has scheduled', () => {
    it('blocks when the controller holds no entry under the id', () => {
      const result = evaluatePreBroadcastGate(input({ scheduledAt: 0n }))
      expect(result.disposition).toBe('BLOCK')
      expect(result.findings[0]).toContain('no schedule entry')
      expect(result.findings[0]).toContain(OP_ID)
    })

    it('holds, rather than blocking, when the controller could not be asked', () => {
      const result = evaluatePreBroadcastGate(input({ scheduledAt: undefined }))
      expect(result.disposition).toBe('HOLD')
      expect(result.findings[0]).toContain('could not be asked')
    })

    // 1 is `TimelockController._DONE_TIMESTAMP`, not a schedule time: the
    // controller writes it over the entry once the operation has run. A bare
    // non-zero test would clear exactly the operation that can only revert.
    it('blocks on the done sentinel rather than treating it as scheduled', () => {
      const result = evaluatePreBroadcastGate(input({ scheduledAt: 1n }))
      expect(result.disposition).toBe('BLOCK')
      expect(result.findings[0]).toContain('already executed')
    })

    it('proceeds on a real schedule time', () => {
      expect(
        evaluatePreBroadcastGate(input({ scheduledAt: 2n })).disposition
      ).toBe('PROCEED')
    })
  })

  describe('the reason says how much was actually checked', () => {
    it('names both counts on a PROCEED, so it cannot read as "everything"', () => {
      const result = evaluatePreBroadcastGate(
        input({ addressesNamed: 5, addressesResolved: 2 })
      )
      expect(result.disposition).toBe('PROCEED')
      expect(result.reason).toContain('2 of 5 calldata address(es)')
      expect(result.reason).toContain('1 declared storage authority value(s)')
      // The claim it must not make: that it looked at everything.
      expect(result.reason).not.toMatch(/\bevery target\b/u)
    })

    it('names them on a BLOCK too', () => {
      const result = evaluatePreBroadcastGate(
        input({
          addressesNamed: 5,
          addressesResolved: 2,
          authorities: [matchingAuthority({ liveValue: STRANGER })],
        })
      )
      expect(result.reason).toContain('2 of 5 calldata address(es)')
    })

    it('reports zero authorities read when the operation declared none', () => {
      const result = evaluatePreBroadcastGate(input({ authorities: [] }))
      expect(result.reason).toContain(
        '0 declared storage authority value(s) were read'
      )
    })
  })

  it('holds when the operation parameters name no address at all', () => {
    const result = evaluatePreBroadcastGate(
      input({ addressesNamed: 0, addressesResolved: 0, authorities: [] })
    )
    expect(result.disposition).toBe('HOLD')
    expect(result.findings[0]).toContain('name no address')
  })

  describe('a missing sign-time record alerts but never refuses', () => {
    it('raises an alert and still proceeds', () => {
      const result = evaluatePreBroadcastGate(
        input({ signTimeRecordPresent: false })
      )
      expect(result.disposition).toBe('PROCEED')
      expect(result.alerts).toHaveLength(1)
      expect(result.alerts[0]).toContain(OP_ID)
      // The alert is visible in the reason, so a PROCEED with a gap does not
      // read the same as a clean one.
      expect(result.reason).toContain('with alerts')
    })

    it('does not add a finding', () => {
      const result = evaluatePreBroadcastGate(
        input({ signTimeRecordPresent: false })
      )
      expect(result.findings).toEqual([])
    })
  })
})

describe('the stored record reaches the decision only as a boolean', () => {
  const observations = {
    operationId: OP_ID,
    scheduledAt: 1_700_000_000n,
    addressesNamed: 1,
    addressesResolved: 1,
    authorities: [matchingAuthority()],
  }

  it('reports presence for a record and absence for either empty value', () => {
    expect(
      deriveGateInput({ ...observations, signTimeRecord: { anything: true } })
        .signTimeRecordPresent
    ).toBe(true)
    expect(
      deriveGateInput({ ...observations, signTimeRecord: null })
        .signTimeRecordPresent
    ).toBe(false)
    expect(
      deriveGateInput({ ...observations, signTimeRecord: undefined })
        .signTimeRecordPresent
    ).toBe(false)
  })

  it('produces an identical gate input from two records that disagree on everything', () => {
    const honest = deriveGateInput({
      ...observations,
      signTimeRecord: {
        codehashes: [{ address: DIAMOND, rawHash: '0xdead' }],
        authorities: [{ label: 'LiFiDiamond.owner()', liveValue: TIMELOCK }],
        signer: TIMELOCK,
      },
    })
    const tampered = deriveGateInput({
      ...observations,
      signTimeRecord: {
        codehashes: [{ address: STRANGER, rawHash: '0xbeef' }],
        authorities: [{ label: 'LiFiDiamond.owner()', liveValue: STRANGER }],
        signer: STRANGER,
        disposition: 'PROCEED',
      },
    })
    expect(tampered).toEqual(honest)
    // And the verdict they produce is the same one.
    expect(evaluatePreBroadcastGate(tampered)).toEqual(
      evaluatePreBroadcastGate(honest)
    )
  })

  it('carries no value from the record into the gate input', () => {
    const derived = deriveGateInput({
      ...observations,
      signTimeRecord: { smuggled: 'a value the proposer wrote' },
    })
    const serialised = JSON.stringify(derived, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
    expect(serialised).not.toContain('smuggled')
    expect(serialised).not.toContain('a value the proposer wrote')
    expect(Object.keys(derived).sort()).toEqual([
      'addressesNamed',
      'addressesResolved',
      'authorities',
      'operationId',
      'scheduledAt',
      'signTimeRecordPresent',
    ])
  })
})
