import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Hex } from 'viem'

import globalConfig from '../../../config/global.json'

import {
  evaluatePeripheryAllowlist,
  parsePeripheryAllowlistRequirements,
  peripheryAllowlistRequirementOn,
} from './peripheryAllowlist'

const DEPOSIT = '0xd0e30db0' as Hex
const WITHDRAW = '0x3ccfd60b' as Hex
const WRAPPER_ONLY = { TokenWrapper: [{ selector: DEPOSIT }] }

describe('parsePeripheryAllowlistRequirements', () => {
  it('reads every contract of the real config with lowercased selectors', () => {
    const { selectors, networkScope } = parsePeripheryAllowlistRequirements(
      globalConfig.whitelistPeripheryFunctions,
      globalConfig.whitelistPeripheryNetworks
    )
    expect(selectors.get('TokenWrapper')).toEqual([DEPOSIT, WITHDRAW])
    expect([...selectors.keys()].sort()).toEqual(
      Object.keys(globalConfig.whitelistPeripheryFunctions).sort()
    )
    expect(networkScope.get('LiFiDEXAggregator')?.has('lens')).toBe(true)
  })

  it('normalises checksum-cased selectors and drops duplicates', () => {
    const { selectors } = parsePeripheryAllowlistRequirements({
      TokenWrapper: [
        { selector: '0xD0E30DB0' },
        { selector: '0xd0e30db0' },
        { selector: WITHDRAW },
      ],
    })
    expect(selectors.get('TokenWrapper')).toEqual([DEPOSIT, WITHDRAW])
  })

  it.each([
    ['a non-object', []],
    ['null', null],
    ['an empty selector list', { TokenWrapper: [] }],
    ['a non-array entry', { TokenWrapper: { selector: DEPOSIT } }],
    [
      'a selector that is not 4 bytes',
      { TokenWrapper: [{ selector: '0xd0e3' }] },
    ],
    ['a missing selector', { TokenWrapper: [{ signature: 'deposit()' }] }],
    ['a non-string selector', { TokenWrapper: [{ selector: 1 }] }],
  ])('refuses %s instead of requiring nothing', (_label, config) => {
    expect(() => parsePeripheryAllowlistRequirements(config)).toThrow(
      'whitelistPeripheryFunctions'
    )
  })

  it.each([
    ['a non-object scope', []],
    ['a scope that is not a list', { TokenWrapper: 'gnosis' }],
    ['a scope holding a non-string', { TokenWrapper: [1] }],
  ])('refuses %s', (_label, scope) => {
    expect(() =>
      parsePeripheryAllowlistRequirements(WRAPPER_ONLY, scope)
    ).toThrow('whitelistPeripheryNetworks')
  })

  it('refuses a scope naming a contract that is not diamond-called', () => {
    expect(() =>
      parsePeripheryAllowlistRequirements(WRAPPER_ONLY, {
        TokenWrapperTypo: ['gnosis'],
      })
    ).toThrow('TokenWrapperTypo')
  })

  it.each(['toString', 'constructor', '__proto__'])(
    'answers for a prototype name only when the config declares it (%s)',
    (name) => {
      const requirements = parsePeripheryAllowlistRequirements(WRAPPER_ONLY)
      expect(
        peripheryAllowlistRequirementOn(requirements, name, 'gnosis')
      ).toEqual({ kind: 'not-diamond-called' })
      const declared = parsePeripheryAllowlistRequirements(
        JSON.parse(`{"${name}": [{"selector": "${DEPOSIT}"}]}`)
      )
      expect(peripheryAllowlistRequirementOn(declared, name, 'gnosis')).toEqual(
        { kind: 'required', selectors: [DEPOSIT] }
      )
    }
  )
})

describe('peripheryAllowlistRequirementOn', () => {
  const requirements = parsePeripheryAllowlistRequirements(
    {
      TokenWrapper: [{ selector: DEPOSIT }],
      LiFiDEXAggregator: [{ selector: WITHDRAW }],
    },
    { LiFiDEXAggregator: ['Lens'] }
  )

  it('requires an unscoped contract on every network', () => {
    expect(
      peripheryAllowlistRequirementOn(requirements, 'TokenWrapper', 'gnosis')
    ).toEqual({ kind: 'required', selectors: [DEPOSIT] })
  })

  it('requires a scoped contract on a listed network, in any case', () => {
    expect(
      peripheryAllowlistRequirementOn(requirements, 'LiFiDEXAggregator', 'LENS')
    ).toEqual({ kind: 'required', selectors: [WITHDRAW] })
  })

  it('exempts a scoped contract on an unlisted network', () => {
    expect(
      peripheryAllowlistRequirementOn(
        requirements,
        'LiFiDEXAggregator',
        'gnosis'
      )
    ).toEqual({ kind: 'out-of-scope' })
  })

  it('requires nothing of a contract the config does not name', () => {
    expect(
      peripheryAllowlistRequirementOn(requirements, 'Executor', 'gnosis')
    ).toEqual({ kind: 'not-diamond-called' })
  })
})

describe('evaluatePeripheryAllowlist', () => {
  it('is allowlisted only when every required selector reads true', () => {
    const verdict = evaluatePeripheryAllowlist(
      [DEPOSIT, WITHDRAW],
      new Map([
        [DEPOSIT, true],
        [WITHDRAW, true],
      ])
    )
    expect(verdict.allowlisted).toBe(true)
    expect(verdict.missing).toEqual([])
    expect(verdict.undetermined).toEqual([])
  })

  it('names the selector the chain reports as not allowlisted', () => {
    const verdict = evaluatePeripheryAllowlist(
      [DEPOSIT, WITHDRAW],
      new Map([
        [DEPOSIT, true],
        [WITHDRAW, false],
      ])
    )
    expect(verdict.allowlisted).toBe(false)
    expect(verdict.missing).toEqual([WITHDRAW])
  })

  it('treats a selector with no read as undetermined, never as allowlisted', () => {
    const verdict = evaluatePeripheryAllowlist(
      [DEPOSIT, WITHDRAW],
      new Map([[DEPOSIT, true]])
    )
    expect(verdict.allowlisted).toBe(false)
    expect(verdict.missing).toEqual([])
    expect(verdict.undetermined).toEqual([
      { selector: WITHDRAW, reason: 'not read' },
    ])
  })

  it('carries a failed read as undetermined with its reason', () => {
    const verdict = evaluatePeripheryAllowlist(
      [DEPOSIT],
      new Map([[DEPOSIT, { failed: 'rpc down' }]])
    )
    expect(verdict.allowlisted).toBe(false)
    expect(verdict.undetermined).toEqual([
      { selector: DEPOSIT, reason: 'rpc down' },
    ])
  })

  it('matches reads keyed by an upper-case selector', () => {
    const verdict = evaluatePeripheryAllowlist(
      [DEPOSIT],
      new Map([['0xD0E30DB0' as Hex, true]])
    )
    expect(verdict.allowlisted).toBe(true)
  })

  it('never calls an empty requirement allowlisted', () => {
    const verdict = evaluatePeripheryAllowlist([], new Map())
    expect(verdict.allowlisted).toBe(false)
  })
})
