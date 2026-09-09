// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { keccak256, toHex } from 'viem'

import type { IAttestedBuild, IObservedCode } from '../codehash/attested-set'

import {
  evaluatePreBroadcastGate,
  type IPreBroadcastAuthority,
  type IPreBroadcastGateInput,
  type IPreBroadcastTarget,
} from './prebroadcast-rederive'

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const FACET = '0x00000000000000000000000000000000000000aa'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'
const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // pre-commit-checker: not a secret — a synthetic test hash

const GOOD_MASKED_HASH = keccak256(toHex('the build of main'))
const GOOD_RAW_HASH = keccak256(toHex('the exact deployed bytes'))

const observed = (overrides: Partial<IObservedCode> = {}): IObservedCode => ({
  maskedHash: GOOD_MASKED_HASH,
  rawByteLength: 1440,
  rawHash: GOOD_RAW_HASH,
  maskedByteCount: 0,
  solcVersion: '0.8.29',
  ...overrides,
})

const attestedBuild = (
  overrides: Partial<IAttestedBuild> = {}
): IAttestedBuild => ({
  lineage: 'local build of main',
  solcVersion: '0.8.29',
  maskedHash: GOOD_MASKED_HASH,
  rawByteLength: 1440,
  rawHash: undefined,
  ...overrides,
})

const matchingTarget = (
  overrides: Partial<IPreBroadcastTarget> = {}
): IPreBroadcastTarget => ({
  address: DIAMOND,
  resolvedContractName: 'LiFiDiamond',
  observed: observed(),
  observationError: undefined,
  attested: [attestedBuild()],
  scope: { isClosedSet: true },
  ...overrides,
})

const matchingAuthority = (
  overrides: Partial<IPreBroadcastAuthority> = {}
): IPreBroadcastAuthority => ({
  label: 'LiFiDiamond.owner()',
  liveValue: TIMELOCK,
  expectedValue: TIMELOCK,
  readError: undefined,
  ...overrides,
})

const input = (
  overrides: Partial<IPreBroadcastGateInput> = {}
): IPreBroadcastGateInput => ({
  operationId: OP_ID,
  onChainOperationId: OP_ID,
  targets: [matchingTarget()],
  authorities: [matchingAuthority()],
  signTimeRecordPresent: true,
  ...overrides,
})

describe('evaluatePreBroadcastGate — the happy path it must be able to reach', () => {
  it('proceeds when every target matches an attested build and every authority matches config', () => {
    const result = evaluatePreBroadcastGate(input())

    // Pinned as the literal, not through the type: an assertion written as
    // `result.disposition === PROCEED_SYMBOL` would move with a mutation.
    expect(result.disposition).toBe('PROCEED')
    expect(result.blocksBroadcast).toBe(false)
    expect(result.findings).toEqual([])
    expect(result.alerts).toEqual([])
  })

  it('is the only disposition that permits a broadcast', () => {
    const proceed = evaluatePreBroadcastGate(input())
    const block = evaluatePreBroadcastGate(
      input({ onChainOperationId: '0xdead' })
    )
    const hold = evaluatePreBroadcastGate(
      input({ onChainOperationId: undefined })
    )

    expect(proceed.blocksBroadcast).toBe(false)
    expect(block.disposition).toBe('BLOCK')
    expect(block.blocksBroadcast).toBe(true)
    expect(hold.disposition).toBe('HOLD')
    expect(hold.blocksBroadcast).toBe(true)
  })
})

describe('evaluatePreBroadcastGate — proven integrity failures block', () => {
  it('blocks a diverged codehash at a target address', () => {
    const result = evaluatePreBroadcastGate(
      input({
        targets: [
          matchingTarget({
            observed: observed({
              maskedHash: keccak256(toHex('swapped code')),
            }),
          }),
        ],
      })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.blocksBroadcast).toBe(true)
    expect(result.findings.join('\n')).toContain(DIAMOND)
    expect(result.findings.join('\n')).toContain('LiFiDiamond')
  })

  it('blocks when the code normalises to the attested build but is longer than it', () => {
    const result = evaluatePreBroadcastGate(
      input({
        targets: [
          matchingTarget({ observed: observed({ rawByteLength: 1487 }) }),
        ],
      })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join('\n')).toContain('not accounted for')
  })

  it('blocks when the timelock recomputes a different operation id', () => {
    const scheduled =
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' // pre-commit-checker: not a secret — a synthetic test hash
    const result = evaluatePreBroadcastGate(
      input({ onChainOperationId: scheduled })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join('\n')).toContain(scheduled)
    expect(result.findings.join('\n')).toContain(OP_ID)
  })

  it('compares operation ids case-insensitively rather than blocking on casing', () => {
    const result = evaluatePreBroadcastGate(
      input({ onChainOperationId: OP_ID.toUpperCase().replace('0X', '0x') })
    )

    expect(result.disposition).toBe('PROCEED')
  })

  it('blocks a storage authority that has moved off what main declares', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [
          matchingAuthority({
            liveValue: '0x00000000000000000000000000000000000000bb',
          }),
        ],
      })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings.join('\n')).toContain('LiFiDiamond.owner()')
    expect(result.findings.join('\n')).toContain(
      '0x00000000000000000000000000000000000000bb'
    )
  })

  it('accepts an authority that differs only in casing', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [
          matchingAuthority({
            liveValue: '0x00000000000000000000000000000000000000A1',
          }),
        ],
      })
    )

    expect(result.disposition).toBe('PROCEED')
  })
})

describe('evaluatePreBroadcastGate — what it cannot verify, it holds', () => {
  it('holds when the timelock could not be asked to recompute the id', () => {
    const result = evaluatePreBroadcastGate(
      input({ onChainOperationId: undefined })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('unconfirmed')
  })

  it('holds on an operation naming no target rather than reading it as all clear', () => {
    const result = evaluatePreBroadcastGate(
      input({ targets: [], authorities: [] })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('name no target')
  })

  it('holds when a live code read failed', () => {
    const result = evaluatePreBroadcastGate(
      input({
        targets: [
          matchingTarget({
            observed: undefined,
            observationError: 'HTTP request failed',
          }),
        ],
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('HTTP request failed')
  })

  it('holds when no observation was supplied at all', () => {
    const result = evaluatePreBroadcastGate(
      input({
        targets: [
          matchingTarget({ observed: undefined, observationError: undefined }),
        ],
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('no live code observation')
  })

  it('holds on an address main binds no single contract to', () => {
    const undeclared = evaluatePreBroadcastGate(
      input({ targets: [matchingTarget({ resolvedContractName: undefined })] })
    )
    const empty = evaluatePreBroadcastGate(
      input({ targets: [matchingTarget({ resolvedContractName: '' })] })
    )

    expect(undeclared.disposition).toBe('HOLD')
    expect(undeclared.findings.join('\n')).toContain('no single contract')
    expect(empty.disposition).toBe('HOLD')
  })

  it('holds when no attested build exists for the contract', () => {
    const result = evaluatePreBroadcastGate(
      input({ targets: [matchingTarget({ attested: [] })] })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('no attested build')
  })

  it('holds when an authority read failed', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [
          matchingAuthority({
            liveValue: undefined,
            readError: 'execution reverted',
          }),
        ],
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('execution reverted')
  })

  it('holds when main declares no expected value, rather than defaulting to agreement', () => {
    const result = evaluatePreBroadcastGate(
      input({ authorities: [matchingAuthority({ expectedValue: undefined })] })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('declares no expected value')
  })

  it('holds when an authority row carries no live value', () => {
    const result = evaluatePreBroadcastGate(
      input({
        authorities: [
          matchingAuthority({ liveValue: undefined, readError: undefined }),
        ],
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings.join('\n')).toContain('no live value')
  })
})

describe('evaluatePreBroadcastGate — the missing record alerts and never decides', () => {
  it('still proceeds with no sign-time record, raising an alert instead', () => {
    const withRecord = evaluatePreBroadcastGate(
      input({ signTimeRecordPresent: true })
    )
    const withoutRecord = evaluatePreBroadcastGate(
      input({ signTimeRecordPresent: false })
    )

    expect(withRecord.disposition).toBe('PROCEED')
    expect(withRecord.alerts).toEqual([])
    expect(withoutRecord.disposition).toBe('PROCEED')
    expect(withoutRecord.blocksBroadcast).toBe(false)
    expect(withoutRecord.alerts).toHaveLength(1)
    expect(withoutRecord.alerts[0]).toContain('no sign-time verdict record')
    expect(withoutRecord.findings).toEqual([])
  })

  it('leaves a blocking verdict blocking, and does not turn an alert into a finding', () => {
    const result = evaluatePreBroadcastGate(
      input({
        signTimeRecordPresent: false,
        onChainOperationId: '0xdead',
      })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.alerts).toHaveLength(1)
    expect(result.findings.join('\n')).not.toContain('sign-time verdict record')
  })
})

describe('evaluatePreBroadcastGate — collecting findings', () => {
  it('lets a proven failure decide even when a read also failed', () => {
    const result = evaluatePreBroadcastGate(
      input({
        targets: [
          matchingTarget({
            observed: observed({ maskedHash: keccak256(toHex('swapped')) }),
          }),
          matchingTarget({
            address: FACET,
            resolvedContractName: 'OwnershipFacet',
            observed: undefined,
            observationError: 'timeout',
          }),
        ],
      })
    )

    expect(result.disposition).toBe('BLOCK')
    expect(result.findings).toHaveLength(2)
    expect(result.findings.join('\n')).toContain('timeout')
  })

  it('reports every finding so one never hides another', () => {
    const result = evaluatePreBroadcastGate(
      input({
        targets: [
          matchingTarget({ resolvedContractName: undefined }),
          matchingTarget({ address: FACET, attested: [] }),
        ],
        authorities: [
          matchingAuthority({ expectedValue: undefined }),
          matchingAuthority({
            label: 'LiFiDiamond.pauserWallet()',
            liveValue: undefined,
            readError: 'reverted',
          }),
        ],
      })
    )

    expect(result.disposition).toBe('HOLD')
    expect(result.findings).toHaveLength(4)
  })
})
