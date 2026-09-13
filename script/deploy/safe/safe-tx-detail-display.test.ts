import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { trustedMarkup } from './printable-field'
import {
  buildCalldataTarget,
  buildSafeTxDetailLines,
  signatureTally,
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
  data: '      raw calldata: \u001b[32m[2J[H[32mfake\u001b[0m\u001b[33m ⚠ sanitised for display — stored 16, printable 13\u001b[0m',
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
  nonceWarning: trustedMarkup(''),
  to: '0x11f1022cA6AdEF6400e5677528a80d49a069C00c',
  toTargetName: '',
  formatAddress: (address: string) => address,
  explorerUrlFor: () => '',
  value: '0',
  operationLabel: trustedMarkup('Call'),
  operationIsCall: true,
  data: '0xdeadbeef',
}

/**
 * One payload carrying each escape family the ticket names: CSI (ESC + '['),
 * a bare C1 CSI and OSC, an OSC-8 hyperlink, and a line separator.
 */
const HOSTILE =
  '\u001b[2J\u001b[H\u009b31m\u009d0;evil\u0007\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u2028fake line'

/**
 * The whole of zone 1 as a signer sees it.
 *
 * The block and its footnote are separate exports because the decoded calldata
 * is written to the console between them, but every property asserted here is a
 * property of the zone, so the tests read it as one.
 */
const linesFor = (overrides: Partial<ISafeTxDetailInput>): string[] => {
  const input = { ...benign, ...overrides }
  return [...buildSafeTxDetailLines(input), ...buildCalldataTarget(input)]
}

/**
 * The envelope: the line naming the target, and the one continuing it.
 *
 * Returned as one string because they are one statement — the target, then its
 * value and the decorations the repository adds. A fold between them is a
 * layout detail, and an assertion about the target should not have to know
 * which side of it a name landed on.
 */
const targetLine = (lines: string[]): string => {
  const index = lines.findIndex((line) =>
    line.trimStart().startsWith('Target: ')
  )
  if (index < 0) throw new Error(`no target line in:\n${lines.join('\n')}`)
  // Bounded by the raw calldata line rather than by a line count. How many
  // lines the target takes is decided by measured width, so a fixed slice
  // either drops a continuation or swallows the hex as soon as the view's
  // width changes.
  const next = lines.findIndex(
    (line, at) => at > index && line.trimStart().startsWith('raw calldata: ')
  )
  return lines.slice(index, next < 0 ? undefined : next).join('\n')
}

/**
 * The two lines rendering a stored address, and how each is found.
 *
 * The target moved under the calldata heading and the proposer stayed in the
 * identity block, so the pair is named once here rather than by every test that
 * asserts the same property of both.
 */
const ADDRESS_FIELDS = [['to', (lines: string[]) => targetLine(lines)]] as const

/** The line carrying the value — beside the target, or folded under it. */
const valueLine = (lines: string[]): string => {
  const found = lines.find((line) => line.includes('msg.value: '))
  if (!found) throw new Error(`no value line in:\n${lines.join('\n')}`)
  return found
}

/** The parked-cleanup line, found by its arrow rather than by its position. */
const parkedLine = (lines: string[]): string => {
  const found = lines.find((line) => line.includes(' \u2192 '))
  if (!found) throw new Error(`no parked line in:\n${lines.join('\n')}`)
  return found
}

/**
 * The zone with the payload on the screen.
 *
 * The calldata is printed only under `--raw`, so every assertion about how a
 * stored value is disclosed has to ask for the mode that renders it — the field
 * is otherwise absent, and an assertion on an absent line proves nothing.
 */
const rawLinesFor = (overrides: Partial<ISafeTxDetailInput>): string[] =>
  linesFor({ ...overrides, showRawCalldata: true })

/** The raw calldata, which is on the screen only under `--raw`. */
const calldataFootnote = (lines: string[]): string => {
  const found = lines.find((line) =>
    line.trimStart().startsWith('raw calldata: ')
  )
  if (!found) throw new Error(`no calldata line in:\n${lines.join('\n')}`)
  return found
}

describe('no proposer-controlled field can drive the signer’s terminal', () => {
  // Named rather than `keyof ISafeTxDetailInput`: these are exactly the fields
  // the block sanitises, and the wider type also admitted the two callbacks.
  const cases: {
    field: 'data' | 'to' | 'value'
    find: (lines: string[]) => string
  }[] = [
    { field: 'data', find: calldataFootnote },
    { field: 'to', find: targetLine },
    { field: 'value', find: valueLine },
  ]

  /**
   * The calldata is on the screen only under `--raw`, so that is the only mode
   * in which the field whose escapes this asserts on is rendered at all.
   */
  const rawIfCalldata = (field: string): Partial<ISafeTxDetailInput> =>
    field === 'data' ? { showRawCalldata: true } : {}

  for (const { field, find } of cases)
    it(`strips every terminal-driving character from ${String(field)}`, () => {
      const line = find(linesFor({ ...rawIfCalldata(field), [field]: HOSTILE }))

      // The colour codes this module writes are the only escapes permitted;
      // anything the row contributed has to be gone from what is left. Split
      // first: the target renders across two lines, and the join is the test's
      // own newline rather than one the module wrote.
      expectNoTerminalControl(line.split('\n'))
      // Paired present: the field is still rendered, not silently dropped.
      expect(line).toContain('fake line')
    })

  it('lets no escape from the row survive, byte for byte', () => {
    // An SGR payload specifically: the structural checks cannot see one.
    const sgr = '\u001b[2J\u001b[H\u001b[32mfake'
    for (const [key, expected] of Object.entries(HOSTILE_GOLDENS)) {
      const line = calldataFootnote(
        linesFor({ [key]: sgr, showRawCalldata: true })
      )
      expect(line).toBe(expected)
    }
  })

  it('strips them from a parked-cleanup facet and PR link', () => {
    const lines = linesFor({
      parkedTaskRefs: [{ facet: HOSTILE, prUrl: HOSTILE }],
    })
    const parked = lines.filter(
      (line) => line.startsWith('        ') && !line.includes('value ')
    )

    expect(parked).toHaveLength(1)
    expect(stripOwnColours(parked[0] ?? '').match(TERMINAL_DRIVING)).toBeNull()
    expect(parked[0]).toContain('fake line')
  })

  it('leaves no terminal-driving character anywhere in the block', () => {
    const lines = linesFor({
      data: HOSTILE,
      to: HOSTILE,
      value: HOSTILE,
      parkedTaskRefs: [{ facet: HOSTILE, prUrl: HOSTILE }],
    })

    expectNoTerminalControl(lines)
  })
})

describe('a hostile row is disclosed, not quietly cleaned', () => {
  it('marks a field whose stored value is not what is shown', () => {
    const line = calldataFootnote(rawLinesFor({ data: HOSTILE }))

    expect(line).toContain('sanitised for display')
  })

  it('reports both lengths, so two rows that render alike stay distinct', () => {
    const zeroWidth = calldataFootnote(rawLinesFor({ data: '0x1\u200b2' }))
    const plain = calldataFootnote(rawLinesFor({ data: '0x12' }))

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
      expect(calldataFootnote(rawLinesFor({ data: hidden }))).toContain(
        '1 invisible character among 5 printable'
      )

    expect(
      calldataFootnote(rawLinesFor({ data: '0x1\u200d\u31642' }))
    ).toContain('2 invisible characters among 6 printable')
  })

  it('still marks a hostile value after the network formatter runs', () => {
    // The formatter is applied to the sanitised text, so a value that needed
    // sanitising must still say so on the address lines.
    for (const [field, find] of ADDRESS_FIELDS) {
      const line = find(
        linesFor({
          [field]: '0x1\u200b2',
          formatAddress: (address: string) => `${address} (0x41…)`,
        })
      )
      expect(line).toContain('stored 5, printable 4')
      expect(line).toContain('(0x41…)')
    }
  })

  it('reports a stripped character and a surviving invisible one together', () => {
    // Either alone is disclosed; a value carrying both must not have the
    // second silenced by the first.
    const line = calldataFootnote(rawLinesFor({ data: '0x1\r\u200d2' }))

    expect(line).toContain('sanitised for display')
    expect(line).toContain('invisible character')
  })

  it('sanitises what a display callback returns, not only what it is given', () => {
    // The callbacks receive a sanitised address, but what reaches the line is
    // their return value, so one that reached for the stored row instead would
    // render it raw.
    const line = targetLine(
      linesFor({
        formatAddress: () => '0xBAD\u001b[2J\u001b[Hfake',
        explorerUrlFor: () => 'https://x/\u001b[2Jevil',
      })
    )

    // Per line: the target renders across two, and joining them for the
    // assertion would introduce a newline the module never wrote.
    expectNoTerminalControl(line.split('\n'))
    expect(line).toContain('fake')
  })

  it('resolves no name and no link for an address it had to repair', () => {
    // Sanitising a corrupt address can yield a valid one — a zero-width space
    // inside the hex just disappears — and naming that would present a corrupt
    // row as a known contract with a working link.
    const repaired = targetLine(
      linesFor({
        to: '0x11f1022cA6AdEF6400e5677528a80\u200bd49a069C00c',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      })
    )

    expect(repaired).not.toContain('(LiFiDiamond)')
    expect(repaired).not.toContain('etherscan')
    expect(repaired).toContain('sanitised for display')
    // And the omission is stated: a bare address otherwise reads as "not a
    // known contract", which is the opposite of what happened.
    expect(repaired).toContain('target name withheld')

    // Nothing is claimed when there was no name to withhold.
    expect(
      targetLine(
        linesFor({
          to: `${benign.to as string}\u200d`,
          toTargetName: '',
        })
      )
    ).not.toContain('withheld')

    // The same row without the zero-width space keeps both.
    const clean = targetLine(
      linesFor({
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      })
    )
    expect(clean).toContain('(LiFiDiamond)')
    expect(clean).toContain('etherscan')
  })

  it('builds no explorer link for a target that was never an address', () => {
    // Surviving sanitising untouched is what a value that was never an address
    // does, so identity alone cannot gate the link: the network formatter
    // passes an unrecognised shape through and the explorer builder
    // interpolates whatever it is handed.
    const line = targetLine(
      linesFor({
        to: 'this-is-not-an-address',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) =>
          `https://etherscan.io/address/${address}`,
      })
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
    const line = targetLine(
      linesFor({
        to: `0x${'1'.repeat(39)}`,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) =>
          `https://etherscan.io/address/${address}`,
      })
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
    const line = targetLine(
      linesFor({
        network: 'tron',
        to: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) => `https://tronscan.org/${address}`,
      })
    )

    expect(line).not.toContain('not a valid address')
    expect(line).toContain('(LiFiDiamond)')
    expect(line).toContain('tronscan')
  })

  it('still refuses a non-address target on a Tron network', () => {
    // A `T…` prefix is not an address by itself, so the refusing branch has to
    // stay reachable on Tron too — the network that accepts base58 is the one
    // where the notice would otherwise be absent for every shape.
    const line = targetLine(
      linesFor({
        network: 'tron',
        to: 'Tnot-an-address',
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: (address: string) => `https://tronscan.org/${address}`,
      })
    )

    expect(line).toContain('not a valid address')
    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('tronscan')
  })

  it('keeps the name and link when only surrounding whitespace was lost', () => {
    // Trimming the ends cannot change which address this is, and the name is
    // the strongest confirmation the signer gets that the target is the
    // contract they expect.
    const line = targetLine(
      linesFor({
        to: `  ${benign.to as string}  `,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      })
    )

    expect(line).toContain('(LiFiDiamond)')
    expect(line).toContain('etherscan')
    // The repair is still disclosed.
    expect(line).toContain('sanitised for display')
  })

  it('drops the name and link for an invisible character the sanitiser keeps', () => {
    // The stripped case is covered above; this is the branch where stored and
    // printable have the same length, so a change-detector would miss it.
    const line = targetLine(
      linesFor({
        to: `${benign.to as string}‍`,
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      })
    )

    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('etherscan')
    expect(line).toContain('invisible character')
  })

  it('drops the name and link for a target that cannot be coerced', () => {
    const line = targetLine(
      linesFor({
        to: {
          toString() {
            throw new Error('nope')
          },
        },
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
      })
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
      const line = targetLine(
        linesFor({
          to,
          toTargetName: '(LiFiDiamond)',
          explorerUrlFor: () => 'https://etherscan.io/address/0x11',
        })
      )

      expect(line).not.toContain('(LiFiDiamond)')
      expect(line).not.toContain('etherscan')
      expect(line).toContain('not a valid address')
    }
  })

  it('shows no name or link beside an address that would not render', () => {
    // A formatter that throws used to yield an empty fragment, leaving the
    // name and the link describing nothing at all.
    const line = targetLine(
      linesFor({
        toTargetName: '(LiFiDiamond)',
        explorerUrlFor: () => 'https://etherscan.io/address/0x11',
        formatAddress: () => {
          throw new Error('no codec for this network')
        },
      })
    )

    expect(line).not.toContain('(LiFiDiamond)')
    expect(line).not.toContain('etherscan')
    expect(line).toContain('shown unformatted')
    // The stored address is still shown, unformatted, rather than nothing.
    expect(line).toContain(benign.to as string)
  })

  it('sanitises the target name, which is a string the caller composes', () => {
    const line = targetLine(
      linesFor({
        toTargetName: '(LiFiDiamond)\u001b[2J',
      })
    )

    expectNoTerminalControl(line.split('\n'))
    expect(line).toContain('(LiFiDiamond)')
  })

  it('blames nothing for a field that is blank because it is empty', () => {
    // An empty stored value renders empty because it is empty; a renderer
    // notice there would name the wrong cause and add a line the display
    // never had.
    for (const [field, find] of ADDRESS_FIELDS)
      expect(find(linesFor({ [field]: '' }))).not.toContain('shown unformatted')
  })

  it('hands the formatter and the explorer the sanitised text, not the row', () => {
    // Both are given `text`. Passing the stored value instead would put the
    // unsanitised string on the line as the address, under a notice still
    // claiming it had been sanitised.
    const padded = `  ${benign.to as string}  `
    const line = targetLine(
      linesFor({
        to: padded,
        formatAddress: (address: string) => `fmt${address.length}`,
        explorerUrlFor: (address: string) => `https://x/url${address.length}`,
      })
    )

    // Distinct markers, or the formatter's output alone satisfies both halves
    // and nothing constrains what the explorer was handed.
    expect(line).toContain(`fmt${(benign.to as string).length}`)
    expect(line).toContain(`url${(benign.to as string).length}`)
    expect(line).not.toContain(`fmt${padded.length}`)
    expect(line).not.toContain(`url${padded.length}`)
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
    expect(targetLine(linesFor({ formatAddress: () => throwing }))).toContain(
      benign.to as string
    )
  })

  it('renders no explorer link for a target that sanitises to nothing', () => {
    const line = targetLine(
      linesFor({
        to: ' ',
        explorerUrlFor: () => 'https://etherscan.io/address/',
      })
    )

    expect(line).not.toContain('etherscan')
  })

  it('keeps the unformatted-address warning outside the value\u2019s colour', () => {
    const line = targetLine(
      linesFor({
        formatAddress: () => {
          throw new Error('no codec')
        },
      })
    )

    expect(line).toContain('\u001b[33m \u26a0 shown unformatted')
    expect(line.indexOf('\u001b[0m')).toBeLessThan(
      line.indexOf('shown unformatted')
    )
  })

  it('keeps a missing field visibly missing', () => {
    // Rendering it blank would make a row with no `data` — still cast to Hex
    // and signed — read exactly like one carrying `0x`.
    expect(calldataFootnote(rawLinesFor({ data: undefined }))).toContain(
      'undefined'
    )
    expect(calldataFootnote(rawLinesFor({ data: null }))).toContain('null')
  })

  it('puts the notice outside the value\u2019s colour, never inside it', () => {
    // Inside, a notice would render in the value's green and read as part of
    // the value rather than as a warning about it.
    const line = calldataFootnote(rawLinesFor({ data: HOSTILE }))
    expect(line.indexOf('\u001b[0m')).toBeLessThan(
      line.indexOf('sanitised for display')
    )
    expect(line).toContain('\u001b[33m \u26a0')
  })

  it('counts length in code points, not UTF-16 units', () => {
    // A two-emoji value is two characters to a reader and four units to
    // `.length`; the number exists for the reader.
    const line = calldataFootnote(
      rawLinesFor({ data: '\u{1f600}\u{1f600}\u0007' })
    )
    expect(line).toContain('stored 3, printable 2')
  })

  it('says so when a field renders to nothing at all', () => {
    const line = targetLine(linesFor({ to: '\u001b\u0007\u009b' }))

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
      expect(calldataFootnote(rawLinesFor({ data: value as never }))).toContain(
        expected
      )

    // `typeof null` is 'object'; a stored null renders as "null" and is not a
    // malformed container.
    expect(calldataFootnote(rawLinesFor({ data: null }))).not.toContain(
      'not a string'
    )
    // A stored empty string is legitimate and stays unremarked.
    expect(calldataFootnote(rawLinesFor({ data: '' }))).not.toContain('⚠')
  })

  it('separates two remarks so neither reads as part of the other', () => {
    const line = calldataFootnote(rawLinesFor({ data: ['0x1‍'] }))

    expect(line).toContain('; ')
    expect(line).toContain('stored as an array, not a string')
    expect(line).toContain('invisible character')
  })

  it('counts invisibles among the printable text, not the stored value', () => {
    // U+200B is stripped, so reporting it as surviving would be a false alarm
    // about a character the reader is not being shown.
    expect(calldataFootnote(rawLinesFor({ data: '0x1​2' }))).not.toContain(
      'invisible character'
    )
    // And in code points: two emoji plus a joiner is three characters.
    expect(
      calldataFootnote(rawLinesFor({ data: '\u{1f600}\u{1f600}‍' }))
    ).toContain('among 3 printable')
  })

  it('marks a value that cannot be coerced at all', () => {
    const line = calldataFootnote(
      rawLinesFor({
        data: {
          toString() {
            throw new Error('nope')
          },
        },
      })
    )

    expect(line).toContain('unrenderable')
    // Without the notice this is indistinguishable from a row storing the
    // literal string "unrenderable".
    expect(line).toContain('value cannot be shown')
  })

  it('renders the provenance it is given, not a fresh absence', () => {
    // `formatClaimLines` has its own suite; what is unobserved here is the
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
    // `formatClaimLines` says "block could not be rendered", this module's
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

    // Handled by `formatClaimLines` itself.
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

    // The rest of the zone survives a broken provenance row: the claim block
    // is the one that failed, and what it qualifies still renders.
    expect(lines.some((line) => line.includes('THE CALLDATA DOES'))).toBe(true)
  })

  it('leaves a benign field unmarked', () => {
    for (const line of buildSafeTxDetailLines(benign))
      expect(line).not.toContain('sanitised for display')
  })
})

describe('the zone renders as one block, byte for byte', () => {
  it('pins every line a signer reads on a routine proposal', () => {
    expect(linesFor({}).join('\n')).toBe(
      [
        'Safe Transaction Details:',
        // The blank belongs to the block heading, which separates itself from
        // whatever preceded it. In the run that is the zone heading's own
        // trailing blank, so the caller passes no heading and the block opens
        // straight on the claim.
        '',
        '  \u001b[1mTHE PROPOSER SAYS\u001b[0m',
        '\u001b[33m      \u2014 not recorded (proposal predates provenance capture)\u001b[0m',
        '',
        '  \u001b[1mTHE CALLDATA DOES\u001b[0m',
        '      Target: \u001b[32m0x11f1022cA6AdEF6400e5677528a80d49a069C00c\u001b[0m   -   msg.value: \u001b[32m0\u001b[0m',
      ].join('\n')
    )
  })

  it('drops its own heading when the caller names the block', () => {
    const [first] = buildSafeTxDetailLines({ ...benign, heading: '' })

    // And opens on the claim rather than on a blank: the zone heading above it
    // already ends on one, and two in a row read as a gap in the output.
    expect(first).toContain('THE PROPOSER SAYS')
  })

  it('states an operation that is not a Call without grading it', () => {
    const lines = linesFor({
      operationLabel: trustedMarkup('DelegateCall'),
      operationIsCall: false,
    }).join('\n')

    // No alarm here any more: gate D grades the operation and
    // `assertProposalOperationPermitted` refuses it. Zone 1 stating the verdict
    // as well is the mixing this layout exists to end.
    expect(lines).not.toContain('NOT A PLAIN CALL')
    // The weight still changes, because the word itself is the statement.
    expect(lines).toContain('\u001b[1m\u001b[31mDelegateCall')
  })

  it('says the decode describes a call a delegatecall will not make', () => {
    // Without this, everything under THE CALLDATA DOES is a false statement:
    // a delegatecall runs the target's own code, whatever the selector says.
    const lines = linesFor({
      operationLabel: trustedMarkup('DelegateCall'),
      operationIsCall: false,
    }).join('\n')

    expect(lines).toContain('A delegatecall will')
    expect(lines).toContain("it runs the target's own code instead")
  })

  it('says nothing of the kind on a plain Call', () => {
    expect(linesFor({}).join('\n')).not.toContain('delegatecall')
  })

  it('places the target name and explorer link in the target’s colours', () => {
    expect(
      targetLine(
        linesFor({
          toTargetName: '(LiFiDiamond)',
          explorerUrlFor: () => 'https://etherscan.io/address/0x11',
        })
      )
    ).toBe(
      '      Target: \u001b[32m0x11f1022cA6AdEF6400e5677528a80d49a069C00c\u001b[0m   -   msg.value: \u001b[32m0\u001b[0m \u00b7 \u001b[33m(LiFiDiamond)\u001b[0m \u00b7 \u001b[36mhttps://etherscan.io/address/0x11\u001b[0m'
    )
  })

  it('breaks to a continuation line rather than folding a URL in two', () => {
    // The one fold this block must never make. Paired with the case above,
    // which fits on one line: without a fixture that overflows, widening the
    // view silently retires the whole continuation path rather than covering
    // it.
    const url = `https://etherscan.io/address/${'0'.repeat(60)}`
    const lines = targetLine(
      linesFor({
        toTargetName: `(${'Very'.repeat(10)}LongDiamondName)`,
        explorerUrlFor: () => url,
      })
    ).split('\n')

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.some((line) => line.includes(url))).toBe(true)
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

describe('the signature tally is short enough for the heading', () => {
  // Pinned by value: an assertion that recomputes the string moves with any
  // mutation of the function that produces it.
  const cases: [number, number, string][] = [
    [0, 3, '0 of 3 signed'],
    [1, 3, '1 of 3 signed'],
    [2, 3, '2 of 3 signed'],
    [3, 3, '3 of 3 signed'],
    // Above the threshold, which a row can carry.
    [4, 3, '4 of 3 signed'],
  ]

  for (const [count, threshold, expected] of cases)
    it(`describes ${count} of ${threshold}`, () => {
      expect(signatureTally(count, threshold)).toBe(expected)
    })

  it('leaves room for the network and the nonce beside it', () => {
    // The heading pads from a fixed width; the longest realistic right-hand
    // side has to fit what is left of 76 columns.
    const right = `arbitrum · nonce 100 · ${signatureTally(10, 20)}`

    expect(right.length).toBeLessThanOrEqual(38)
  })
})

describe('the calldata is reachable in full, one flag away', () => {
  it('prints nothing about the payload unless --raw asked for it', () => {
    // A length and a first word are not something a signer can check anything
    // against, and the decode below names the function those four bytes select.
    const lines = linesFor({ data: '0xdead\u200bbeef' })

    expect(lines.some((line) => line.includes('raw calldata: '))).toBe(false)
    expect(lines.join('\n')).not.toContain('hex chars')
    expect(lines.join('\n')).not.toContain('deadbeef')
  })

  it('discloses what it had to repair in the payload it prints', () => {
    const line = calldataFootnote(
      linesFor({ data: '0xdead\u200bbeef', showRawCalldata: true })
    )

    expect(line).toContain('sanitised for display — stored 11, printable 10')
  })

  it('shows a value that is not calldata as stored', () => {
    const line = calldataFootnote(
      linesFor({ data: 'not-hex-at-all', showRawCalldata: true })
    )

    expect(line).toContain('not-hex-at-all')
  })
})

describe('the block is total — no row shape costs the operator the run', () => {
  it('renders a row whose fields are absent', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      data: undefined,
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

    const line = calldataFootnote(
      linesFor({ data: throwing, showRawCalldata: true })
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
  it('keeps a wall of hex off the screen entirely', () => {
    // The twenty-odd lines above the claim are what a signer is here to weigh,
    // and 10,000 characters of hex scroll every one of them away.
    const calldata = `0x${'ab'.repeat(5_000)}`
    expect(linesFor({ data: calldata }).join('\n')).not.toContain('abababab')
  })

  it('leaves the calldata whole under --raw — it is the payload under signature', () => {
    const calldata = `0x${'ab'.repeat(5_000)}`
    expect(calldataFootnote(rawLinesFor({ data: calldata }))).toBe(
      `      raw calldata: \u001b[32m${calldata}\u001b[0m`
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

    expect(parkedLine(lines)).toBe(
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

    expect(parkedLine(lines)).toBe(
      '        \u001b[32mAcrossFacetV3\u001b[0m → \u001b[36mhttps://github.com/lifinance/contracts/pull/1\u001b[0m'
    )
  })

  it('withholds the target name for a homoglyph address', () => {
    const line = targetLine(
      linesFor({
        to: '0x11f1022cA6AdEF6400e5677528a80d49a069C0\u043ec',
        toTargetName: '(LiFiDiamond)',
      })
    )

    expect(line).toContain('target name withheld')
    expect(line).not.toContain('(LiFiDiamond)')
  })
})
