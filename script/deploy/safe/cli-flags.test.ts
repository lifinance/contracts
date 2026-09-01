import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { readBooleanFlag, readValueFlag } from './cli-flags'

const LEDGER_LIVE = { camel: 'ledgerLive', kebab: 'ledger-live' } as const

describe('readBooleanFlag', () => {
  const read = (...argv: string[]) => readBooleanFlag(argv, LEDGER_LIVE)

  it('reads a bare flag as true, in either spelling', () => {
    expect(read('--ledgerLive')).toBe(true)
    expect(read('--ledger-live')).toBe(true)
  })

  it('is false when absent', () => {
    expect(read()).toBe(false)
    expect(read('--network', 'mainnet')).toBe(false)
  })

  it.each([
    ['assigned true', ['--ledgerLive=true'], true],
    ['assigned true, kebab', ['--ledger-live=true'], true],
    ['assigned false', ['--ledgerLive=false'], false],
    ['assigned false, kebab', ['--ledger-live=false'], false],
    ['space-separated true', ['--ledgerLive', 'true'], true],
    ['space-separated false', ['--ledgerLive', 'false'], false],
    ['negated', ['--no-ledgerLive'], false],
    ['negated, kebab', ['--no-ledger-live'], false],
  ])('reads %s', (_label, argv, expected) => {
    expect(readBooleanFlag(argv, LEDGER_LIVE)).toBe(expected)
  })

  it.each([
    ['=no', ['--ledgerLive=no']],
    ['=yes', ['--ledgerLive=yes']],
    ['=1', ['--ledger-live=1']],
    ['=0', ['--ledgerLive=0']],
    ['=off', ['--ledgerLive=off']],
    ['=TRUE, wrong case', ['--ledgerLive=TRUE']],
    ['an empty assignment', ['--ledgerLive=']],
    ['a space-separated no', ['--ledgerLive', 'no']],
    ['a space-separated 1', ['--ledger-live', '1']],
  ])('refuses %s rather than guessing', (_label, argv) => {
    expect(() => readBooleanFlag(argv, LEDGER_LIVE)).toThrow(
      /accepts no value, 'true' or 'false'/
    )
  })

  it('refuses the flag twice, rather than silently taking one of them', () => {
    expect(() => read('--ledgerLive=false', '--ledgerLive')).toThrow(
      /given more than once/
    )
    expect(() => read('--ledger-live', '--ledgerLive')).toThrow(
      /given more than once/
    )
    expect(() => read('--ledgerLive', '--no-ledgerLive')).toThrow(
      /given more than once/
    )
  })

  it('does not mistake a longer flag that starts with the same name', () => {
    expect(read('--ledgerLiveExtra')).toBe(false)
    expect(read('--ledger-live-extra=true')).toBe(false)
  })

  it("does not read the flag name out of another argument's value", () => {
    // A reason or a path can legitimately contain the text.
    expect(read('--reason', 'switch to --ledgerLive next time')).toBe(false)
    expect(read('--reason=--ledgerLive')).toBe(false)
  })

  it('ignores everything after a bare -- terminator', () => {
    expect(read('--', '--ledgerLive')).toBe(false)
  })

  it("treats a following flag as absence, not as this flag's value", () => {
    expect(read('--ledgerLive', '--network')).toBe(true)
  })
})

describe('readValueFlag', () => {
  const ACCOUNT = { camel: 'accountIndex', kebab: 'account-index' } as const
  const read = (...argv: string[]) => readValueFlag(argv, ACCOUNT)

  it('reads an assigned and a space-separated value, both spellings', () => {
    expect(read('--accountIndex=4')).toBe('4')
    expect(read('--account-index=4')).toBe('4')
    expect(read('--accountIndex', '4')).toBe('4')
    expect(read('--account-index', '4')).toBe('4')
  })

  it('is undefined when absent', () => {
    expect(read()).toBeUndefined()
  })

  it('returns an empty assignment as an empty string, not as absent', () => {
    // `--accountIndex=` must reach the validator as a value the operator typed,
    // so it can be refused; reporting absence would silently default it to 0.
    expect(read('--accountIndex=')).toBe('')
  })

  it('refuses a valueless flag rather than reporting an empty value', () => {
    // citty hands a bare `--derivationPath` back as `''`, which is falsy, so
    // the resolver dropped it and derived from the default path instead.
    expect(() => read('--accountIndex')).toThrow(/needs a value/)
    expect(() => read('--accountIndex', '--network')).toThrow(/needs a value/)
  })

  it('refuses the flag twice', () => {
    expect(() => read('--accountIndex=1', '--account-index=2')).toThrow(
      /given more than once/
    )
  })

  it('keeps a value that itself contains an equals sign', () => {
    const PATH = { camel: 'derivationPath', kebab: 'derivation-path' } as const
    expect(readValueFlag(['--derivationPath=m/44=1'], PATH)).toBe('m/44=1')
  })

  it('keeps a negative-looking value for the validator to judge', () => {
    expect(read('--accountIndex=-1')).toBe('-1')
  })
})

describe('readBooleanFlag — flags that default on', () => {
  const LEDGER = { camel: 'ledger', kebab: 'ledger' } as const
  const read = (...argv: string[]) =>
    readBooleanFlag(argv, LEDGER, { whenAbsent: true })

  it('is on when absent', () => {
    // confirm-safe-tx signs with a Ledger unless told otherwise, so absence
    // must not read as off.
    expect(read()).toBe(true)
  })

  it('is off when explicitly negated or assigned false', () => {
    expect(read('--no-ledger')).toBe(false)
    expect(read('--ledger=false')).toBe(false)
    expect(read('--ledger', 'false')).toBe(false)
  })

  it('is on when passed bare or assigned true', () => {
    expect(read('--ledger')).toBe(true)
    expect(read('--ledger=true')).toBe(true)
  })

  it('still refuses a value it cannot read', () => {
    expect(() => read('--ledger=yes')).toThrow(/accepts no value/)
  })
})

describe('readBooleanFlag — the negated spelling takes no value', () => {
  it.each([
    ['--no-ledgerLive=false', ['--no-ledgerLive=false']],
    ['--no-ledgerLive=true', ['--no-ledgerLive=true']],
    ['--no-ledger-live false', ['--no-ledger-live', 'false']],
  ])(
    'refuses %s, a double negative with no obvious reading',
    (_label, argv) => {
      expect(() => readBooleanFlag(argv, LEDGER_LIVE)).toThrow(/takes no value/)
    }
  )
})
