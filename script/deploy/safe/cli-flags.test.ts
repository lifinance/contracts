import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { defineCommand, runCommand } from 'citty'

import { flagIsOn, readBooleanFlag, readValueFlag } from './cli-flags'

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

describe('readValueFlag — the negated spelling is not a form of the flag', () => {
  const ACCOUNT = { camel: 'accountIndex', kebab: 'account-index' } as const

  it.each([
    ['--no-accountIndex=3', ['--no-accountIndex=3']],
    ['--no-account-index 3', ['--no-account-index', '3']],
  ])('refuses %s', (_label, argv) => {
    // The boolean reader refuses this shape; the value reader used to accept it
    // and return '3'. Two readers in one module ruling opposite ways on the same
    // spelling is how a value gets read where it should have been rejected.
    expect(() => readValueFlag(argv, ACCOUNT)).toThrow(/not a form of/)
  })
})

/**
 * `flagIsOn` exists for a command body that only sees `args`. These run the
 * real parser over the two argument shapes that matter, because the failure it
 * guards against — a `--dry-run` that resolves to `false` and broadcasts — is
 * invisible to a test that builds `args` by hand.
 */
describe('flagIsOn, against citty as it actually resolves flags', () => {
  /** Resolves `dryRun` the way a command body would see it. */
  const resolve = async (
    declaration: Record<string, unknown>,
    ...argv: string[]
  ): Promise<unknown> => {
    let seen: unknown
    await runCommand(
      defineCommand({
        args: { dryRun: { type: 'boolean', ...declaration } },
        run: ({ args }) => {
          seen = args.dryRun
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      { rawArgs: argv }
    )
    return seen
  }

  it('is on for both spellings when the argument declares no default', async () => {
    expect(flagIsOn(await resolve({}, '--dryRun'))).toBe(true)
    expect(flagIsOn(await resolve({}, '--dry-run'))).toBe(true)
    expect(flagIsOn(await resolve({}, '--dry-run=true'))).toBe(true)
  })

  it('is off when the argument is absent, or explicitly false', async () => {
    expect(flagIsOn(await resolve({}))).toBe(false)
    expect(flagIsOn(await resolve({}, '--dry-run=false'))).toBe(false)
    expect(flagIsOn(await resolve({}, '--dryRun=false'))).toBe(false)
  })

  it('is on when a bare kebab flag swallowed the next token as its value', async () => {
    // citty hands the following argv entry to a kebab boolean. Reading that as
    // "off" would broadcast a run the operator asked to simulate.
    expect(flagIsOn(await resolve({}, '--dry-run', 'extra'))).toBe(true)
  })

  it('is on when the swallowed token was numeric, so arrived as a number', async () => {
    // The token is numeric-parsed rather than kept as a string, so a reader
    // that tests for `typeof === 'string'` calls this off and broadcasts.
    expect(await resolve({}, '--dry-run', '5')).toBe(5)
    expect(flagIsOn(await resolve({}, '--dry-run', '5'))).toBe(true)
    // 0 is the case a truthiness test also gets wrong.
    expect(await resolve({}, '--dry-run', '0')).toBe(0)
    expect(flagIsOn(await resolve({}, '--dry-run', '0'))).toBe(true)
  })

  it('refuses a flag passed twice rather than picking a winner', async () => {
    // citty collapses repeats into an array. Reducing one would have to choose,
    // and the safe choice flips per flag: on for --dry-run, off for
    // --allowOverride. Both directions are refused, so neither can be wrong.
    expect(await resolve({}, '--dry-run', '--dry-run')).toEqual([true, true])
    expect(() => flagIsOn([true, true])).toThrow(/given more than once/)
    expect(await resolve({}, '--dry-run=false', '--dry-run=false')).toEqual([
      'false',
      'false',
    ])
    expect(() => flagIsOn(['false', 'false'])).toThrow(/given more than once/)
    expect(() => flagIsOn(['true', 'false'])).toThrow(/given more than once/)
  })

  it('is unaffected when the two spellings are mixed, which citty does not collapse', async () => {
    // Different keys, so no array and nothing ambiguous to refuse.
    expect(await resolve({}, '--dryRun', '--dry-run')).toBe(true)
  })

  it('is off for a repeated negation, which citty collapses to a plain false', async () => {
    // The `--no-` branch assigns rather than concatenating, so this never
    // becomes an array and needs no refusal.
    expect(await resolve({}, '--no-dry-run', '--no-dry-run')).toBe(false)
    expect(flagIsOn(await resolve({}, '--no-dry-run', '--no-dry-run'))).toBe(
      false
    )
  })

  it('resolves an unreadable value to on, which is why on must be the safe direction', async () => {
    // Deliberate, not an oversight: for --dry-run, on is the fail-safe answer.
    // The same reading is fail-dangerous for a flag that widens the run's
    // reach, and those go through readBooleanFlag instead — see
    // strict-flag-placement.test.ts.
    //
    // Driven through the parser rather than asserted on literals: `0` only ever
    // reaches this function via the kebab spelling, because mri coerces the
    // declared spelling's value to a boolean. A literal would assert a shape
    // whose reachability it does not show.
    expect(await resolve({}, '--dry-run', '0')).toBe(0)
    expect(flagIsOn(await resolve({}, '--dry-run', '0'))).toBe(true)
    expect(await resolve({}, '--dry-run', 'no')).toBe('no')
    expect(flagIsOn(await resolve({}, '--dry-run', 'no'))).toBe(true)
    // The declared spelling never produces it, which is why the kebab one is
    // the case that matters:
    expect(await resolve({}, '--dryRun', '0')).toBe(true)
  })

  it("reads '' as off, for a value argument passed through this reader", () => {
    // Unreachable for a `type: 'boolean'` argument; asserted directly so the
    // clause is not left as untested code.
    expect(flagIsOn('')).toBe(false)
    expect(flagIsOn('', { whenAbsent: true })).toBe(false)
  })

  it('cannot rescue a declaration that carries a default', async () => {
    // This is why the declaration must omit `default`: citty resolves the
    // spelling the caller did not type to it, and `args.dryRun` never sees the
    // kebab value at all.
    expect(await resolve({ default: false }, '--dry-run')).toBe(false)
    expect(flagIsOn(await resolve({ default: false }, '--dry-run'))).toBe(false)
    expect(flagIsOn(await resolve({ default: false }, '--dryRun'))).toBe(true)
  })
})

/**
 * A flag that is on unless switched off cannot express its fallback as a citty
 * `default` either, so `whenAbsent` carries it. `--no-use-cache` is the shape
 * that was broken in practice: the declaration's `default: true` sat on the key
 * the body read, and the negation the description told operators to type landed
 * on the other one.
 */
describe('flagIsOn whenAbsent, against citty as it actually resolves flags', () => {
  /** Resolves `useCache` the way a command body would see it. */
  const resolve = async (
    declaration: Record<string, unknown>,
    ...argv: string[]
  ): Promise<unknown> => {
    let seen: unknown
    await runCommand(
      defineCommand({
        args: { useCache: { type: 'boolean', ...declaration } },
        run: ({ args }) => {
          seen = args.useCache
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      { rawArgs: argv }
    )
    return seen
  }

  const on = async (...argv: string[]) =>
    flagIsOn(await resolve({}, ...argv), { whenAbsent: true })

  it('is on when absent', async () => {
    expect(await on()).toBe(true)
    expect(await on('--network', 'mainnet')).toBe(true)
  })

  it('is off for either negated spelling', async () => {
    expect(await on('--no-use-cache')).toBe(false)
    expect(await on('--no-useCache')).toBe(false)
    expect(await on('--use-cache=false')).toBe(false)
    expect(await on('--useCache=false')).toBe(false)
  })

  it('is on when passed bare, in either spelling', async () => {
    expect(await on('--use-cache')).toBe(true)
    expect(await on('--useCache')).toBe(true)
  })

  it('stays on for a swallowed numeric token', async () => {
    expect(await on('--use-cache', '5')).toBe(true)
    expect(await on('--use-cache', '0')).toBe(true)
  })

  it('refuses a repeat here too, where ON is the unsafe direction', async () => {
    // `--allowOverride=false` twice used to read as on, i.e. permit the write.
    expect(await resolve({}, '--use-cache=false', '--use-cache=false')).toEqual(
      ['false', 'false']
    )
    expect(() => flagIsOn(['false', 'false'], { whenAbsent: true })).toThrow(
      /given more than once/
    )
  })

  it('cannot be switched off at all once the declaration carries the default', async () => {
    // The defect this replaces: `default: true` occupies `useCache`, so the
    // kebab negation never reaches the body and the cache stays on.
    const declared = { default: true }
    expect(
      flagIsOn(await resolve(declared, '--no-use-cache'), { whenAbsent: true })
    ).toBe(true)
    // Same operator intent, spelled the way the declaration happens to want:
    expect(
      flagIsOn(await resolve(declared, '--no-useCache'), { whenAbsent: true })
    ).toBe(false)
  })
})

/**
 * Step 3 of the same pattern: a value argument's fallback also belongs in the
 * body, for the same reason and with a worse failure — the value the operator
 * passed is not merely ignored, it is replaced by the default.
 */
describe('a value argument, against citty as it actually resolves flags', () => {
  /** Resolves `delaySeconds` the way a command body would see it. */
  const resolve = async (
    declaration: Record<string, unknown>,
    ...argv: string[]
  ): Promise<unknown> => {
    let seen: unknown
    await runCommand(
      defineCommand({
        args: { delaySeconds: { type: 'string', ...declaration } },
        run: ({ args }) => {
          seen = args.delaySeconds
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      { rawArgs: argv }
    )
    return seen
  }

  it('reaches the body in either spelling when the declaration omits the default', async () => {
    expect(await resolve({}, '--delaySeconds', '99')).toBe('99')
    // Only the declared spelling is registered with the raw parser as a string,
    // so a numeric-looking value arrives as a number under the other one. It is
    // the same value, but a body that calls a string method on it throws —
    // which is why these fallbacks are written `String(args.x ?? DEFAULT)`.
    expect(await resolve({}, '--delay-seconds', '99')).toBe(99)
    expect(await resolve({}, '--delay-seconds=99')).toBe(99)
    expect(await resolve({}, '--delay-seconds', 'later')).toBe('later')
  })

  it('is undefined when absent, so the body applies `?? DEFAULT`', async () => {
    expect(await resolve({})).toBeUndefined()
  })

  it('is discarded for the kebab spelling once the declaration carries a default', async () => {
    expect(await resolve({ default: '5' }, '--delay-seconds', '99')).toBe('5')
    expect(await resolve({ default: '5' }, '--delaySeconds', '99')).toBe('99')
  })

  it('arrives as a falsy 0, so a body must test presence and not truthiness', async () => {
    // `if (args.delaySeconds)` would drop an explicit `--delay-seconds 0` and
    // fall back to the default; the fallback has to be keyed on `undefined`.
    expect(await resolve({}, '--delay-seconds', '0')).toBe(0)
    expect(await resolve({}, '--delaySeconds', '0')).toBe('0')
  })

  it('keeps a non-numeric value a string under either spelling', async () => {
    expect(await resolve({}, '--delay-seconds', 'later')).toBe('later')
    expect(await resolve({}, '--delaySeconds', 'later')).toBe('later')
  })
})
