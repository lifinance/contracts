/**
 * The Ledger account-selection flags shared by every Safe script that can sign
 * with one: `--accountIndex` and `--derivationPath`.
 *
 * What these tests hold is that each script reaches its guard with the value
 * the operator typed. Every layer below is permissive — citty coerces,
 * `Number()` converts, and the Ledger SDK's BIP32 parser accepts whatever
 * segment it is handed, dropping an unparseable one and deriving from the rest
 * — so a script that validates anywhere other than at the flag produces a
 * valid-looking address from a value nobody chose.
 */

import { readFileSync, readdirSync } from 'fs'
import { join, relative, resolve } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { readValueFlag } from './cli-flags'
import { parseAccountIndex } from './safe-utils'

const ACCOUNT_INDEX = { camel: 'accountIndex', kebab: 'account-index' } as const

/** The expression every Safe CLI evaluates for `--accountIndex`. */
const readAccountIndex = (...argv: string[]): number =>
  parseAccountIndex(readValueFlag(argv, ACCOUNT_INDEX))

const SCRIPT_ROOT = resolve(__dirname, '../..')

/** A citty `accountIndex` argument, i.e. a script an operator can pass one to. */
const DECLARES_ACCOUNT_INDEX = /accountIndex:\s*\{[^}]*type:\s*'string'/

/**
 * Discovered rather than listed: the case worth catching is a script added
 * later that converts the flag itself, and a hand-maintained list would not
 * contain it.
 *
 * @param dir - Directory to walk.
 * @returns Every script under `script/` that offers `--accountIndex`.
 */
const findLedgerSigningScripts = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' ? [] : findLedgerSigningScripts(path)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts'))
      return []
    return DECLARES_ACCOUNT_INDEX.test(readFileSync(path, 'utf8')) ? [path] : []
  })

const LEDGER_SIGNING_SCRIPTS = findLedgerSigningScripts(SCRIPT_ROOT).map(
  (path) => relative(SCRIPT_ROOT, path)
)

describe('parseAccountIndex', () => {
  it('defaults to account 0 when the flag is absent', () => {
    expect(parseAccountIndex(undefined)).toBe(0)
  })

  it.each([
    ['plain', '3', 3],
    ['zero', '0', 0],
    ['already a number', 7, 7],
  ])('accepts a %s index', (_label, value, expected) => {
    expect(parseAccountIndex(value as string | number)).toBe(expected)
  })

  // Each of these reaches the Ledger SDK's BIP32 splitPath as a path segment:
  // 'abc' becomes NaN and the segment is dropped entirely, '3.7' truncates to 3
  // and '-1' wraps to 2147483647. All three derive a different, valid-looking
  // address and none of them errors, so the refusal has to happen here.
  it.each([
    ['non-numeric', 'abc'],
    ['fractional', '3.7'],
    ['negative', '-1'],
    ['empty', ''],
    ['whitespace-only', '  '],
    ['boolean', true],
  ])('refuses a %s index', (_label, value) => {
    expect(() => parseAccountIndex(value as string | number)).toThrow(
      /accountIndex must be a non-negative integer/
    )
  })

  it('quotes the value it was given, so the operator sees what was read', () => {
    expect(() => parseAccountIndex('3.7')).toThrow("got '3.7'")
  })
})

describe('--accountIndex, as the Safe CLIs read it', () => {
  it('reads an index in either spelling and either form', () => {
    expect(readAccountIndex('--accountIndex', '3')).toBe(3)
    expect(readAccountIndex('--accountIndex=3')).toBe(3)
    expect(readAccountIndex('--account-index', '3')).toBe(3)
    expect(readAccountIndex('--account-index=3')).toBe(3)
  })

  it('is account 0 when the flag is absent', () => {
    expect(readAccountIndex('--network', 'mainnet')).toBe(0)
  })

  // Every argv below is one an operator can actually produce.
  // `--accountIndex "$UNSET_VAR"` is the one that matters most: the shell
  // expands it to nothing, so the flag arrives carrying an empty value rather
  // than not arriving at all, and a numeric conversion reads it as account 0.
  it.each([
    ['an unset shell variable', ['--accountIndex', '']],
    ['an empty assignment', ['--accountIndex=']],
    ['an empty kebab assignment', ['--account-index=']],
    ['a non-numeric value', ['--accountIndex', 'abc']],
    ['a fractional value', ['--accountIndex=3.7']],
    ['a negative value', ['--accountIndex=-1']],
  ])('refuses %s', (_label, argv) => {
    expect(() => readAccountIndex(...argv)).toThrow(
      /accountIndex must be a non-negative integer/
    )
  })

  it.each([
    ['a valueless flag', ['--accountIndex']],
    ['a valueless kebab flag', ['--account-index']],
  ])('refuses %s', (_label, argv) => {
    // citty reports the first as `''` and the second as boolean `true`, so a
    // conversion reads the same typo as account 0 or account 1 depending only
    // on which spelling was used. Neither is distinguishable from a deliberate
    // index once converted, so the flag has to be read before the parser.
    expect(() => readAccountIndex(...argv)).toThrow(/needs a value/)
  })

  it('refuses a repeated flag rather than picking an occurrence', () => {
    expect(() =>
      readAccountIndex('--accountIndex', '3', '--account-index', '5')
    ).toThrow(/more than once/)
  })
})

/**
 * Any numeric conversion applied to something named after the account index.
 *
 * Matched on the identifier rather than on one call shape: naming the raw value
 * and converting it a line later reinstates the whole defect while a pattern
 * anchored on `args.accountIndex` still passes.
 */
const CONVERTS_THE_INDEX =
  /(?:Number|parseInt|parseFloat)\s*\(\s*[^)]*[Aa]ccount[Ii]ndex/

/** Any read of the index off citty's parsed args, in any accessor spelling. */
const READS_THE_PARSED_ARG =
  /args\s*(?:\?\.|\.)\s*accountIndex|args\s*\[\s*['"`]accountIndex/

describe('no Ledger-signing script converts --accountIndex itself', () => {
  const source = (file: string) => readFileSync(join(SCRIPT_ROOT, file), 'utf8')

  it('finds the scripts that offer the flag', () => {
    // A discovery bug would make every assertion below vacuously pass.
    expect(LEDGER_SIGNING_SCRIPTS).toContain('deploy/safe/propose-to-safe.ts')
    expect(LEDGER_SIGNING_SCRIPTS.length).toBeGreaterThanOrEqual(5)
  })

  it.each(LEDGER_SIGNING_SCRIPTS)('%s does not convert the index', (file) => {
    // Converting anywhere ahead of the guard destroys the evidence it needs:
    // '' and boolean `true` both become plausible indices and nothing downstream
    // can tell them from a deliberate one.
    expect(source(file)).not.toMatch(CONVERTS_THE_INDEX)
  })

  it.each(LEDGER_SIGNING_SCRIPTS)(
    '%s reads the raw flag from argv, not from the parsed args',
    (file) => {
      // citty cannot represent the difference between `--account-index` and
      // `--account-index=`, so a predicate over `args.accountIndex` can no
      // longer tell an operator's value from an absence.
      const text = source(file)
      expect(text).toContain("kebab: 'account-index'")
      expect(text).not.toMatch(READS_THE_PARSED_ARG)
    }
  )

  // Listed, not discovered: the claim is about these three specifically, which
  // hand the flag straight to the guard in one expression. The two remaining
  // scripts validate a hop away — `propose-to-safe.ts` inside `_runPropose`,
  // `cleanUpProdDiamond.ts` inside `resolveSafeSigningOptions` — so the
  // adjacency below would not hold for them.
  it.each([
    'deploy/safe/confirm-safe-tx.ts',
    'deploy/safe/add-safe-owners-and-threshold.ts',
    'deploy/safe/ledger-flex-calibrate.ts',
  ])('%s guards the flag in the same expression that reads it', (file) => {
    expect(source(file)).toMatch(/parseAccountIndex\(\s*readValueFlag\(/)
  })
})

describe('--derivationPath is read as a value, not as a flag', () => {
  const source = (file: string) => readFileSync(join(SCRIPT_ROOT, file), 'utf8')

  // The two scripts that resolve the path inline. `cleanUpProdDiamond.ts` gets
  // the same treatment through `resolveSafeSigningOptions`, and
  // `ledger-flex-calibrate.ts` offers no `--derivationPath` at all.
  const INLINE = [
    'deploy/safe/confirm-safe-tx.ts',
    'deploy/safe/add-safe-owners-and-threshold.ts',
  ]

  it.each(INLINE)('%s reads the path from argv', (file) => {
    const text = source(file)
    expect(text).toContain("kebab: 'derivation-path'")
    expect(text).not.toMatch(/args\s*(?:\?\.|\.)\s*derivationPath/)
  })

  it.each(INLINE)('%s refuses an empty path', (file) => {
    // `--derivationPath "$UNSET_VAR"` arrives as ''. Passed on, splitPath('')
    // returns an empty BIP32 path and the device derives from it without
    // erroring; treated as absent, it silently selects the default path.
    expect(source(file)).toMatch(
      /derivationPath[\s\S]{0,120}trim\(\)\s*===\s*''/
    )
  })
})
