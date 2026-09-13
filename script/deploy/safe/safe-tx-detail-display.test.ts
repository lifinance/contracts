import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { trustedMarkup } from './printable-field'
import {
  buildSafeTxDetailLines,
  type ISafeTxDetailInput,
} from './safe-tx-detail-display'

/**
 * Exact renderings for hostile input. The structural assertions below strip the
 * module's own SGR codes before looking for control characters, which cannot
 * distinguish a row-supplied `ESC[31m` from one this module wrote — so the
 * property that no escape survives from the row is pinned here, byte for byte,
 * where a sanitiser that started passing SGR through would fail.
 */
const HOSTILE_GOLDENS: Record<string, string> = {
  'Data:':
    '    Data:            \u001b[32m[2J[H[32mfake\u001b[0m\u001b[33m ⚠ sanitised for display — stored 16, printable 13\u001b[0m',
  'Proposer:':
    '    Proposer:        \u001b[32m[2J[H[32mfake\u001b[0m\u001b[33m ⚠ sanitised for display — stored 16, printable 13\u001b[0m',
}

/** Anything outside the colour codes this module writes itself. */
const TERMINAL_DRIVING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
// eslint-disable-next-line no-control-regex -- matching the escape sequences is the point
const OWN_COLOUR_CODES = /\u001b\[\d+m/gu

const stripOwnColours = (line: string): string =>
  line.replace(OWN_COLOUR_CODES, '')

/** Asserted per line: joining them would introduce a newline of the test's own. */
const expectNoTerminalControl = (lines: string[]): void => {
  for (const line of lines)
    expect(stripOwnColours(line).match(TERMINAL_DRIVING)).toBeNull()
}

/** A row with nothing hostile in it. Every field is the shape Mongo stores. */
const benign: ISafeTxDetailInput = {
  network: 'mainnet',
  safeAddress: '0x1a9C8182C09F50C8318d769245beA52c32BE35BC',
  nonce: '31',
  nonceColor: '32',
  nonceWarning: trustedMarkup(''),
  to: '0x11f1022cA6AdEF6400e5677528a80d49a069C00c',
  toTargetName: '',
  formatAddress: (address: string) => address,
  explorerUrlFor: () => '',
  value: '0',
  operationLabel: trustedMarkup('Call'),
  operationIsCall: true,
  data: '0xdeadbeef',
  proposer: '0x5c19DE04c40f9F8Ed9F0Fe6a5cEb84E5C8a5b31E',
  safeTxHash:
    '0x7c6d5e4f3a2b1908172635445362718091a2b3c4d5e6f708192a3b4c5d6e7f80',
  signatureCount: 1,
  threshold: 3,
  canExecute: false,
}

/**
 * One payload carrying each escape family the ticket names: CSI (ESC + '['),
 * a bare C1 CSI and OSC, an OSC-8 hyperlink, and a line separator.
 */
const HOSTILE =
  '\u001b[2J\u001b[H\u009b31m\u009d0;evil\u0007\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u2028fake line'

const linesFor = (overrides: Partial<ISafeTxDetailInput>): string[] =>
  buildSafeTxDetailLines({ ...benign, ...overrides })

const lineStartingWith = (lines: string[], label: string): string => {
  const found = lines.find((line) => line.trimStart().startsWith(label))
  if (!found)
    throw new Error(`no line labelled ${label} in:\n${lines.join('\n')}`)
  return found
}

describe('no proposer-controlled field can drive the signer’s terminal', () => {
  // Named rather than `keyof ISafeTxDetailInput`: these are exactly the fields
  // the block sanitises, and the wider type also admitted the two callbacks.
  const cases: {
    field: 'data' | 'safeTxHash' | 'proposer' | 'to' | 'nonce' | 'value'
    label: string
  }[] = [
    { field: 'data', label: 'Data:' },
    { field: 'safeTxHash', label: 'Safe Tx Hash:' },
    { field: 'proposer', label: 'Proposer:' },
    { field: 'to', label: 'To:' },
    { field: 'nonce', label: 'Nonce:' },
    { field: 'value', label: 'Value:' },
  ]

  for (const { field, label } of cases)
    it(`strips every terminal-driving character from ${String(field)}`, () => {
      const line = lineStartingWith(linesFor({ [field]: HOSTILE }), label)

      // The colour codes this module writes are the only escapes permitted;
      // anything the row contributed has to be gone from what is left.
      expect(stripOwnColours(line).match(TERMINAL_DRIVING)).toBeNull()
      // Paired present: the field is still rendered, not silently dropped.
      expect(line).toContain('fake line')
    })

  it('lets no escape from the row survive, byte for byte', () => {
    // An SGR payload specifically: the structural checks cannot see one.
    const sgr = '\u001b[2J\u001b[H\u001b[32mfake'
    for (const [label, expected] of Object.entries(HOSTILE_GOLDENS)) {
      const field = label === 'Data:' ? 'data' : 'proposer'
      expect(lineStartingWith(linesFor({ [field]: sgr }), label)).toBe(expected)
    }
  })

  it('strips them from a parked-cleanup facet and PR link', () => {
    const lines = linesFor({
      parkedTaskRefs: [{ facet: HOSTILE, prUrl: HOSTILE }],
    })
    const parked = lines.filter((line) => line.startsWith('        '))

    expect(parked).toHaveLength(1)
    expect(stripOwnColours(parked[0] ?? '').match(TERMINAL_DRIVING)).toBeNull()
    expect(parked[0]).toContain('fake line')
  })

  it('leaves no terminal-driving character anywhere in the block', () => {
    const lines = linesFor({
      data: HOSTILE,
      safeTxHash: HOSTILE,
      proposer: HOSTILE,
      nonce: HOSTILE,
      value: HOSTILE,
      parkedTaskRefs: [{ facet: HOSTILE, prUrl: HOSTILE }],
    })

    expectNoTerminalControl(lines)
  })
})

describe('a hostile row is disclosed, not quietly cleaned', () => {
  it('marks a field whose stored value is not what is shown', () => {
    const line = lineStartingWith(linesFor({ data: HOSTILE }), 'Data:')

    expect(line).toContain('sanitised for display')
  })

  it('reports both lengths, so two rows that render alike stay distinct', () => {
    const zeroWidth = lineStartingWith(
      linesFor({ data: '0x1\u200b2' }),
      'Data:'
    )
    const plain = lineStartingWith(linesFor({ data: '0x12' }), 'Data:')

    expect(zeroWidth).toContain('stored 5, printable 4')
    expect(plain).not.toContain('sanitised for display')
    // The visible renderings are identical; only the marker separates them.
    expect(stripOwnColours(plain).trimEnd()).toContain('0x12')
  })

  it('marks a value hiding zero-width characters the sanitiser keeps', () => {
    // U+200D is preserved by design and U+3164 is a printable letter, so
    // neither is stripped and the stored/shown lengths agree — the value is
    // still not what it looks like.
    for (const hidden of ['0x1\u200d2', '0x1\u31642', '0x1\uffa02'])
      expect(lineStartingWith(linesFor({ data: hidden }), 'Data:')).toContain(
        '1 invisible character among 5 printable'
      )

    expect(
      lineStartingWith(linesFor({ data: '0x1\u200d\u31642' }), 'Data:')
    ).toContain('2 invisible characters among 6 printable')
  })

  it('still marks a hostile value after the network formatter runs', () => {
    // The formatter is applied to the sanitised text, so a value that needed
    // sanitising must still say so on the address lines.
    for (const [field, label] of [
      ['to', 'To:'],
      ['proposer', 'Proposer:'],
    ] as const) {
      const line = lineStartingWith(
        buildSafeTxDetailLines({
          ...benign,
          [field]: '0x1\u200b2',
          formatAddress: (address: string) => `${address} (0x41…)`,
        }),
        label
      )
      expect(line).toContain('stored 5, printable 4')
      expect(line).toContain('(0x41…)')
    }
  })

  it('reports a stripped character and a surviving invisible one together', () => {
    // Either alone is disclosed; a value carrying both must not have the
    // second silenced by the first.
    const line = lineStartingWith(linesFor({ data: '0x1\r\u200d2' }), 'Data:')

    expect(line).toContain('sanitised for display')
    expect(line).toContain('invisible character')
  })

  it('sanitises what a display callback returns, not only what it is given', () => {
    // The callbacks receive a sanitised address, but what reaches the line is
    // their return value, so one that reached for the stored row instead would
    // render it raw.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        formatAddress: () => '0xBAD\u001b[2J\u001b[Hfake',
        explorerUrlFor: () => 'https://x/\u001b[2Jevil',
      }),
      'To:'
    )

    expect(stripOwnColours(line).match(TERMINAL_DRIVING)).toBeNull()
    expect(line).toContain('fake')
  })

  it('resolves no name and no link for an address it had to repair', () => {
    // Sanitising a corrupt address can yield a valid one — a zero-width space
    // inside the hex just disappears — and naming that would present a corrupt
    // row as a known contract with a working link.
    const repaired = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: '0x11f1022cA6AdEF6400e5677528a80\u200bd49a069C00c',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      }),
      'To:'
    )

    expect(repaired).not.toContain('(LiFiDiamond)')
    expect(repaired).not.toContain('etherscan')
    expect(repaired).toContain('sanitised for display')
    // And the omission is stated: a bare address otherwise reads as "not a
    // known contract", which is the opposite of what happened.
    expect(repaired).toContain('target name withheld')

    // Nothing is claimed when there was no name to withhold.
    expect(
      lineStartingWith(
        buildSafeTxDetailLines({
          ...benign,
          to: `${benign.to as string}\u200d`,
          toTargetName: '',
        }),
        'To:'
      )
    ).not.toContain('withheld')

    // The same row without the zero-width space keeps both.
    const clean = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      }),
      'To:'
    )
    expect(clean).toContain('(LiFiDiamond)')
    expect(clean).toContain('etherscan')
  })

  it('builds no explorer link for a target that was never an address', () => {
    // Surviving sanitising untouched is what a value that was never an address
    // does, so identity alone cannot gate the link: the network formatter
    // passes an unrecognised shape through and the explorer builder
    // interpolates whatever it is handed.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: 'this-is-not-an-address',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) =>
          `https://etherscan.io/address/${address}`,
      }),
      'To:'
    )

    expect(line).toContain('this-is-not-an-address')
    expect(line).not.toContain('etherscan')
    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).toContain('not a valid address')
  })

  it('builds no explorer link for a target one nibble short of an address', () => {
    // The realistic corruption, and the one the name and link were vouching
    // for: 39 hex digits reads as an address to anyone scanning the prompt, so
    // a check loose enough to accept "hex-shaped" would pass it.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: `0x${'1'.repeat(39)}`,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) =>
          `https://etherscan.io/address/${address}`,
      }),
      'To:'
    )

    expect(line).not.toContain('etherscan')
    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).toContain('not a valid address')
  })

  it('keeps the name and link for a base58 target on a Tron network', () => {
    // Tron rows store base58, and `initializeSafeTransaction` accepts it —
    // `normalizeAddressForNetwork` resolves `T…` to the same 20 bytes a hex
    // address would. A hex-only check would call this signable row "not a
    // valid address" one line above the sign prompt, which is the notice that
    // must never cry wolf.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        network: 'tron',
        to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) => `https://tronscan.org/${address}`,
      }),
      'To:'
    )

    expect(line).not.toContain('not a valid address')
    expect(line).toContain('(LiFiDiamond)')
    expect(line).toContain('tronscan')
  })

  it('still refuses a non-address target on a Tron network', () => {
    // A `T…` prefix is not an address by itself, so the refusing branch has to
    // stay reachable on Tron too — the network that accepts base58 is the one
    // where the notice would otherwise be absent for every shape.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        network: 'tron',
        to: 'Tnot-an-address',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) => `https://tronscan.org/${address}`,
      }),
      'To:'
    )

    expect(line).toContain('not a valid address')
    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('tronscan')
  })

  it('keeps the name and link when only surrounding whitespace was lost', () => {
    // Trimming the ends cannot change which address this is, and the name is
    // the strongest confirmation the signer gets that the target is the
    // contract they expect.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: `  ${benign.to as string}  `,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      }),
      'To:'
    )

    expect(line).toContain('(LiFiDiamond)')
    expect(line).toContain('etherscan')
    // The repair is still disclosed.
    expect(line).toContain('sanitised for display')
  })

  it('drops the name and link for an invisible character the sanitiser keeps', () => {
    // The stripped case is covered above; this is the branch where stored and
    // printable have the same length, so a change-detector would miss it.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: `${benign.to as string}‍`,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      }),
      'To:'
    )

    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('etherscan')
    expect(line).toContain('invisible character')
  })

  it('drops the name and link for a target that cannot be coerced', () => {
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: {
          toString() {
            throw new Error('nope')
          },
        },
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      }),
      'To:'
    )

    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('etherscan')
  })

  it('resolves nothing for a target that was never a string', () => {
    // `String(undefined)` is a word, not an address. Naming it would present a
    // row with no target at all as a known contract. Withholding the name
    // silently is not enough: the line still shows the signer a target, so it
    // has to say why that target carries neither a name nor a link.
    for (const to of [undefined, 42, true]) {
      const line = lineStartingWith(
        buildSafeTxDetailLines({
          ...benign,
          to,
          toTargetName: '(LiFiDiamond)',
          explorerUrlFor: () => 'https://etherscan.io/address/0x11',
        }),
        'To:'
      )

      expect(line).not.toContain('(LiFiDiamond)')
      expect(line).not.toContain('etherscan')
      expect(line).toContain('not a valid address')
    }
  })

  it('shows no name or link beside an address that would not render', () => {
    // A formatter that throws used to yield an empty fragment, leaving the
    // name and the link describing nothing at all.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
        formatAddress: () => {
          throw new Error('no codec for this network')
        },
      }),
      'To:'
    )

    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('etherscan')
    expect(line).toContain('shown unformatted')
    // The stored address is still shown, unformatted, rather than nothing.
    expect(line).toContain(benign.to as string)
  })

  it('sanitises the proposer formatter’s return value, not only its input', () => {
    // `formattedAddressField` has its own call into the formatter; covering
    // only the target's would leave this one unobserved.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        formatAddress: () => '0xP\u001b[2Jwiped',
      }),
      'Proposer:'
    )

    expect(stripOwnColours(line).match(TERMINAL_DRIVING)).toBeNull()
    expect(line).toContain('wiped')
  })

  it('sanitises the target name, which is a string the caller composes', () => {
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        toTargetName: '(LiFiDiamond)\u001b[2J',
      }),
      'To:'
    )

    expect(stripOwnColours(line).match(TERMINAL_DRIVING)).toBeNull()
    expect(line).toContain('(LiFiDiamond)')
  })

  it('says so when the proposer address will not render either', () => {
    // The same branch as the target's, one call site over — the gap that let
    // the silent-blank behaviour survive on this line after it was fixed on
    // the other.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        formatAddress: () => {
          throw new Error('no codec for this network')
        },
      }),
      'Proposer:'
    )

    expect(line).toContain('shown unformatted')
    // The stored address is still shown rather than blanked.
    expect(line).toContain(benign.proposer as string)
  })

  it('blames nothing for a field that is blank because it is empty', () => {
    // An empty stored value renders empty because it is empty; a renderer
    // notice there would name the wrong cause and add a line the display
    // never had.
    for (const [field, label] of [
      ['to', 'To:'],
      ['proposer', 'Proposer:'],
    ] as const)
      expect(lineStartingWith(linesFor({ [field]: '' }), label)).not.toContain(
        'shown unformatted'
      )
  })

  it('hands the formatter and the explorer the sanitised text, not the row', () => {
    // Both are given `text`. Passing the stored value instead would put the
    // unsanitised string on the line as the address, under a notice still
    // claiming it had been sanitised.
    const padded = `  ${benign.to as string}  `
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        to: padded,
        formatAddress: (address: string) => `fmt${address.length}`,
        explorerUrlFor: (address: string) => `https://x/url${address.length}`,
      }),
      'To:'
    )

    // Distinct markers, or the formatter's output alone satisfies both halves
    // and nothing constrains what the explorer was handed.
    expect(line).toContain(`fmt${(benign.to as string).length}`)
    expect(line).toContain(`url${(benign.to as string).length}`)
    expect(line).not.toContain(`fmt${padded.length}`)
    expect(line).not.toContain(`url${padded.length}`)
  })

  it('hands the proposer formatter the sanitised text as well', () => {
    // The target line's version of this is above; sharing one helper between
    // the two call sites does not mean both are observed.
    const padded = `  ${benign.proposer as string}  `
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        proposer: padded,
        formatAddress: (address: string) => `fmt${address.length}`,
      }),
      'Proposer:'
    )

    expect(line).toContain(`fmt${(benign.proposer as string).length}`)
    expect(line).not.toContain(`fmt${padded.length}`)
  })

  it('survives a callback whose return value throws on coercion', () => {
    // The sanitiser coerces what the callback returns, so it can throw where
    // the callback did not. Escaping here costs every remaining network in the
    // run, because the caller has no per-network catch.
    const throwing = {
      toString() {
        throw new Error('boom')
      },
    } as unknown as string

    for (const overrides of [
      { formatAddress: () => throwing },
      { explorerUrlFor: () => throwing },
      { toTargetName: throwing },
    ])
      expect(() =>
        buildSafeTxDetailLines({ ...benign, ...overrides })
      ).not.toThrow()

    // And the block still renders — swallowing the line would pass the
    // assertions above while losing the field the signer is checking.
    expect(
      lineStartingWith(
        buildSafeTxDetailLines({ ...benign, formatAddress: () => throwing }),
        'To:'
      )
    ).toContain(benign.to as string)
  })

  it('renders no explorer link for a target that sanitises to nothing', () => {
    const line = lineStartingWith(
      linesFor({
        to: ' ',
        explorerUrlFor: () => 'https://etherscan.io/address/',
      }),
      'To:'
    )

    expect(line).not.toContain('etherscan')
  })

  it('keeps the unformatted-address warning outside the value\u2019s colour', () => {
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        formatAddress: () => {
          throw new Error('no codec')
        },
      }),
      'To:'
    )

    expect(line).toContain('\u001b[33m \u26a0 shown unformatted')
    expect(line.indexOf('\u001b[0m')).toBeLessThan(
      line.indexOf('shown unformatted')
    )
  })

  it('puts the notice outside the colour on the address lines too', () => {
    for (const [field, label] of [
      ['to', 'To:'],
      ['proposer', 'Proposer:'],
    ] as const) {
      const line = lineStartingWith(linesFor({ [field]: '0x1\u00072' }), label)
      expect(line.indexOf('\u001b[0m')).toBeLessThan(
        line.indexOf('sanitised for display')
      )
    }
  })

  it('keeps a missing field visibly missing', () => {
    // Rendering it blank would make a row with no `data` — still cast to Hex
    // and signed — read exactly like one carrying `0x`.
    expect(lineStartingWith(linesFor({ data: undefined }), 'Data:')).toContain(
      'undefined'
    )
    expect(lineStartingWith(linesFor({ data: null }), 'Data:')).toContain(
      'null'
    )
  })

  it('puts the notice outside the value\u2019s colour, never inside it', () => {
    // Inside, a notice would render in the value's green and read as part of
    // the value rather than as a warning about it.
    const line = lineStartingWith(linesFor({ data: HOSTILE }), 'Data:')
    expect(line.indexOf('\u001b[0m')).toBeLessThan(
      line.indexOf('sanitised for display')
    )
    expect(line).toContain('\u001b[33m \u26a0')
  })

  it('counts length in code points, not UTF-16 units', () => {
    // A two-emoji value is two characters to a reader and four units to
    // `.length`; the number exists for the reader.
    const line = lineStartingWith(
      linesFor({ data: '\u{1f600}\u{1f600}\u0007' }),
      'Data:'
    )
    expect(line).toContain('stored 3, printable 2')
  })

  it('says so when a field renders to nothing at all', () => {
    const line = lineStartingWith(
      linesFor({ proposer: '\u001b\u0007\u009b' }),
      'Proposer:'
    )

    expect(line).toContain('no printable characters')
  })

  it('names a stored value that is not a string, whatever it renders as', () => {
    // Says only what it knows: `[' ']` renders as nothing while holding an
    // element, so "empty" would be a false claim about the container.
    for (const [value, expected] of [
      [[], 'stored as an array, not a string'],
      [[' '], 'stored as an array, not a string'],
      [{}, 'stored as an object, not a string'],
      [new Date(0), 'stored as an object, not a string'],
    ] as const)
      expect(
        lineStartingWith(linesFor({ data: value as never }), 'Data:')
      ).toContain(expected)

    // `typeof null` is 'object'; a stored null renders as "null" and is not a
    // malformed container.
    expect(lineStartingWith(linesFor({ data: null }), 'Data:')).not.toContain(
      'not a string'
    )
    // A stored empty string is legitimate and stays unremarked.
    expect(lineStartingWith(linesFor({ data: '' }), 'Data:')).not.toContain('⚠')
  })

  it('separates two remarks so neither reads as part of the other', () => {
    const line = lineStartingWith(linesFor({ data: ['0x1‍'] }), 'Data:')

    expect(line).toContain('; ')
    expect(line).toContain('stored as an array, not a string')
    expect(line).toContain('invisible character')
  })

  it('counts invisibles among the printable text, not the stored value', () => {
    // U+200B is stripped, so reporting it as surviving would be a false alarm
    // about a character the reader is not being shown.
    expect(
      lineStartingWith(linesFor({ data: '0x1​2' }), 'Data:')
    ).not.toContain('invisible character')
    // And in code points: two emoji plus a joiner is three characters.
    expect(
      lineStartingWith(linesFor({ data: '\u{1f600}\u{1f600}‍' }), 'Data:')
    ).toContain('among 3 printable')
  })

  it('marks a value that cannot be coerced at all', () => {
    const line = lineStartingWith(
      linesFor({
        data: {
          toString() {
            throw new Error('nope')
          },
        },
      }),
      'Data:'
    )

    expect(line).toContain('unrenderable')
    // Without the notice this is indistinguishable from a row storing the
    // literal string "unrenderable".
    expect(line).toContain('value cannot be shown')
  })

  it('keeps the unformatted-address warning outside the proposer colour too', () => {
    // The target line's placement is asserted above; one shared constant does
    // not mean both call sites emit it in the right place.
    const line = lineStartingWith(
      buildSafeTxDetailLines({
        ...benign,
        formatAddress: () => {
          throw new Error('no codec')
        },
      }),
      'Proposer:'
    )

    expect(line.indexOf('\u001b[0m')).toBeLessThan(
      line.indexOf('shown unformatted')
    )
  })

  it('renders the provenance it is given, not a fresh absence', () => {
    // `formatProvenanceLines` has its own suite; what is unobserved here is the
    // wiring. Dropping the argument would make every proposal read "not
    // recorded" and hide the commit, branch and dirty-tree disclosure.
    const lines = buildSafeTxDetailLines({
      ...benign,
      provenance: {
        proposerHandle: 'dblaecker',
        actor: 'human',
        gitCommit: 'a1b2c3d4e5f6a7b8c9d0',
        gitBranch: 'feat/thing',
        dirtyTreeScoped: [],
        captureErrors: [],
        commitOnRemote: true,
      } as never,
    })

    const block = lines.join('\n')
    // Each element the commit message names as at risk, or a mutation keeping
    // the first line and dropping the rest passes.
    expect(block).toContain('dblaecker')
    expect(block).toContain('a1b2c3d4e5f6')
    expect(block).toContain('feat/thing')
    expect(block).toContain('clean')
    expect(block).not.toContain('not recorded')
  })

  it('degrades to a line for a half-migrated provenance row', () => {
    // Two containment layers, and the messages name which one fired:
    // `formatProvenanceLines` says "block could not be rendered", this module's
    // own catch says "could not be rendered". A plain thrown Error is handled
    // there; the shapes below are not.
    const lines = buildSafeTxDetailLines({
      ...benign,
      provenance: {
        get proposerHandle(): string {
          throw new Error('half-migrated row')
        },
      } as never,
    })

    // Handled by `formatProvenanceLines` itself.
    expect(lines.join('\n')).toContain('block could not be rendered')

    // And these are not: it stringifies what was thrown to build that message,
    // so an unstringifiable value makes its handler throw again. Only this
    // module's catch stops them, and a mutation deleting it lets them escape.
    for (const thrown of [
      () => Object.create(null) as unknown,
      () => ({
        toString() {
          throw new Error('inner')
        },
      }),
    ]) {
      const build = (): string[] =>
        buildSafeTxDetailLines({
          ...benign,
          provenance: {
            get proposerHandle(): string {
              throw thrown()
            },
          } as never,
        })
      expect(build).not.toThrow()
      const rendered = build().join('\n')
      expect(rendered).toContain('could not be rendered')
      expect(rendered).not.toContain('block could not be rendered')
    }

    // And the nesting one level deeper: describing the thrown value is itself
    // a coercion, so a value whose `toString` throws something unstringifiable
    // defeats the describing too. The last catch before the network loop
    // cannot be allowed to fail.
    const nested = (): string[] =>
      buildSafeTxDetailLines({
        ...benign,
        provenance: {
          get proposerHandle(): string {
            // A non-Error thrown value is the whole point: a row can produce one.
            // eslint-disable-next-line no-throw-literal
            throw {
              toString() {
                throw Object.create(null)
              },
            }
          },
        } as never,
      })
    expect(nested).not.toThrow()
    expect(nested().join('\n')).toContain(
      'an error that cannot itself be described'
    )

    // The rest of the block survives a broken provenance row.
    expect(lines.some((line) => line.includes('Data:'))).toBe(true)
  })

  it('leaves a benign field unmarked', () => {
    for (const line of buildSafeTxDetailLines(benign))
      expect(line).not.toContain('sanitised for display')
  })
})

describe('a normal proposal renders exactly as it does today', () => {
  it('is byte-identical to the block the signer already reads', () => {
    expect(buildSafeTxDetailLines(benign).join('\n')).toBe(
      [
        'Safe Transaction Details:',
        '    Safe:            [32m0x1a9C8182C09F50C8318d769245beA52c32BE35BC[0m',
        '    Nonce:           \u001b[32m31\u001b[0m',
        '    To:              \u001b[32m0x11f1022cA6AdEF6400e5677528a80d49a069C00c\u001b[0m',
        '    Value:           \u001b[32m0\u001b[0m',
        '    Operation:       \u001b[32mCall\u001b[0m',
        '    Data:            \u001b[32m0xdeadbeef\u001b[0m',
        '    Proposer:        \u001b[32m0x5c19DE04c40f9F8Ed9F0Fe6a5cEb84E5C8a5b31E\u001b[0m',
        '    Safe Tx Hash:    \u001b[36m0x7c6d5e4f3a2b1908172635445362718091a2b3c4d5e6f708192a3b4c5d6e7f80\u001b[0m',
        '    Signatures:      \u001b[32m1/3\u001b[0m required',
        '    Execution Ready: \u001b[31m✗\u001b[0m',
        '    Provenance:      \u001b[33m— not recorded (proposal predates provenance capture) —\u001b[0m',
      ].join('\n')
    )
  })

  it('drops its own heading when the caller names the block', () => {
    const [first] = buildSafeTxDetailLines({ ...benign, heading: '' })

    expect(first).toContain('Safe:')
  })

  it('draws an operation that is not a Call as an alarm, not as a word', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      operationLabel: trustedMarkup('DelegateCall'),
      operationIsCall: false,
    }).join('\n')

    expect(lines).toContain('NOT A PLAIN CALL')
    // The label itself has to change weight too: an alarm under a green word
    // reads as a warning about something else on the screen.
    expect(lines).toContain('[1m[31mDelegateCall')
  })

  it('renders the Safe address through the same funnel as every stored field', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      safeAddress: '0x1a9C[31m8182',
    }).join('\n')

    expect(lines).toContain('sanitised for display')
  })

  it('keeps the nonce warning, explorer suffix and ready mark verbatim', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      nonceColor: '31',
      nonceWarning: trustedMarkup(' \u001b[31m✗ STALE\u001b[0m'),
      explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      canExecute: true,
    })

    expect(lineStartingWith(lines, 'Nonce:')).toBe(
      '    Nonce:           \u001b[31m31\u001b[0m \u001b[31m✗ STALE\u001b[0m'
    )
    expect(lineStartingWith(lines, 'To:')).toBe(
      '    To:              \u001b[32m0x11f1022cA6AdEF6400e5677528a80d49a069C00c \u001b[36mhttps://etherscan.io/address/0x11\u001b[0m\u001b[0m'
    )
    expect(lineStartingWith(lines, 'Execution Ready:')).toBe(
      '    Execution Ready: \u001b[32m✓\u001b[0m'
    )
  })

  it('places the target name and explorer link inside the target colour', () => {
    expect(
      lineStartingWith(
        buildSafeTxDetailLines({
          ...benign,
          toTargetName: '(LiFiDiamond)',
          explorerUrlFor: () => 'https://etherscan.io/address/0x11',
        }),
        'To:'
      )
    ).toBe(
      '    To:              \u001b[32m0x11f1022cA6AdEF6400e5677528a80d49a069C00c \u001b[33m(LiFiDiamond)\u001b[0m \u001b[36mhttps://etherscan.io/address/0x11\u001b[0m\u001b[0m'
    )
  })

  it('renders the parked-cleanup block in its existing shape', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      parkedTaskRefs: [
        { facet: 'AcrossFacetV3', prUrl: 'https://github.com/x/y/pull/1' },
      ],
    })

    expect(lines).toContain('    Parked cleanup — origin PRs:')
    expect(lines).toContain(
      '        \u001b[32mAcrossFacetV3\u001b[0m → \u001b[36mhttps://github.com/x/y/pull/1\u001b[0m'
    )

    // Every ref, not just the first: dropping the tail would hide deprecation
    // context for the facets after it.
    const both = buildSafeTxDetailLines({
      ...benign,
      parkedTaskRefs: [
        { facet: 'AcrossFacetV3', prUrl: 'https://github.com/x/y/pull/1' },
        { facet: 'AmarokFacet', prUrl: 'https://github.com/x/y/pull/2' },
      ],
    })
    expect(both.filter((line) => line.startsWith('        '))).toHaveLength(2)
    expect(both.join('\n')).toContain('AmarokFacet')
  })
})

describe('the block is total — no row shape costs the operator the run', () => {
  it('renders a row whose fields are absent', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      data: undefined,
      safeTxHash: undefined,
      proposer: undefined,
    })

    expect(lines.length).toBeGreaterThan(0)
    expectNoTerminalControl(lines)
  })

  it('renders a row whose field throws on coercion', () => {
    const throwing = {
      toString() {
        throw new Error('nope')
      },
    }

    const line = lineStartingWith(
      buildSafeTxDetailLines({ ...benign, data: throwing }),
      'Data:'
    )

    expect(line).toContain('unrenderable')
  })

  it('renders a parked-refs field that is not an array', () => {
    // A stored document with a `length` satisfies a length check and then
    // throws on `for...of`, which would escape the builder entirely.
    for (const parkedTaskRefs of [
      { length: 2 } as never,
      { length: 1, 0: {} } as never,
      5 as never,
      'abc' as never,
    ]) {
      const build = (): string[] =>
        buildSafeTxDetailLines({ ...benign, parkedTaskRefs })
      expect(build).not.toThrow()
      // Every shape, not just the first: a guard that accepted an iterable
      // with a length would render `undefined → undefined` rows under a real
      // header for a stored string.
      expect(build().some((line) => line.includes('Parked cleanup'))).toBe(
        false
      )
    }
  })

  it('renders a parked ref that is not an object', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      parkedTaskRefs: [undefined as never, 'not an object' as never],
    })

    expectNoTerminalControl(lines)
  })
})

describe('a row needs no escape sequence to scroll the prompt away', () => {
  it('clips a hash grown to 500,000 characters', () => {
    const line = lineStartingWith(
      linesFor({ safeTxHash: `0x${'a'.repeat(500_000)}` }),
      'Safe Tx Hash:'
    )

    // The whole line, bytes included. 120 and 208 are written out rather than
    // derived from MAX_FIELD_CHARS, so raising the bound fails here instead of
    // moving with it — and this line measured 500,032 before the clip existed.
    expect(line).toBe(
      '    Safe Tx Hash:    \u001b[36m0x' +
        'a'.repeat(118) +
        '\u001b[0m\u001b[33m ⚠ clipped for display — stored 500002, shown 120\u001b[0m'
    )
    expect(line.length).toBe(208)
  })

  it('leaves the calldata whole — it is the payload under signature', () => {
    const calldata = `0x${'ab'.repeat(5_000)}`
    expect(lineStartingWith(linesFor({ data: calldata }), 'Data:')).toBe(
      `    Data:            \u001b[32m${calldata}\u001b[0m`
    )
  })

  it('bounds the number of parked refs, not only each one’s length', () => {
    const parkedTaskRefs = Array.from({ length: 40 }, (_, index) => ({
      facet: `Facet${index}`,
      prUrl: 'https://github.com/lifinance/contracts/pull/1',
    }))
    const lines = linesFor({ parkedTaskRefs })
    const refLines = lines.filter((line) => line.includes('→'))

    expect(refLines.length).toBe(20)
    expect(lines).toContain(
      '        \u001b[33m⚠ 20 further parked refs not shown (40 stored)\u001b[0m'
    )
    // Paired present: the refs shown are the first ones, not a window that
    // silently drops the head of the list.
    expect(refLines[0]).toContain('Facet0')
    expect(refLines[19]).toContain('Facet19')
  })

  it('says nothing about an overflow when there is none', () => {
    const lines = linesFor({
      parkedTaskRefs: [{ facet: 'AcrossFacetV3', prUrl: 'https://x/1' }],
    })
    expect(lines.some((line) => line.includes('not shown'))).toBe(false)
  })
})

describe('a facet name drawn identically to another is disclosed', () => {
  it('reports the Cyrillic homoglyph in a parked facet name', () => {
    const lines = linesFor({
      parkedTaskRefs: [
        {
          // AcrossFacetV3 with U+043E in place of the first ASCII "o".
          facet: 'Acr\u043essFacetV3',
          prUrl: 'https://github.com/lifinance/contracts/pull/1',
        },
      ],
    })

    expect(lines[lines.length - 2]).toBe(
      '        \u001b[32mAcr\u043essFacetV3\u001b[0m\u001b[33m ⚠ 1 non-ASCII character — a letter here can be drawn identically to an ASCII one\u001b[0m → \u001b[36mhttps://github.com/lifinance/contracts/pull/1\u001b[0m'
    )
  })

  it('says nothing about an ASCII facet name', () => {
    const lines = linesFor({
      parkedTaskRefs: [
        {
          facet: 'AcrossFacetV3',
          prUrl: 'https://github.com/lifinance/contracts/pull/1',
        },
      ],
    })

    expect(lines[lines.length - 2]).toBe(
      '        \u001b[32mAcrossFacetV3\u001b[0m → \u001b[36mhttps://github.com/lifinance/contracts/pull/1\u001b[0m'
    )
  })

  it('withholds the target name for a homoglyph address', () => {
    const line = lineStartingWith(
      linesFor({
        to: '0x11f1022cA6AdEF6400e5677528a80d49a069C0\u043ec',
        toTargetName: '(LiFiDiamond)',
      }),
      'To:'
    )

    expect(line).toContain('target name withheld')
    expect(line).not.toContain('(LiFiDiamond)')
  })
})
