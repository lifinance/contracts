// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { type Hex } from 'viem'

import {
  applyStyleRanges,
  HASH_COMPARE_CHARS,
  joinPanelsHorizontally,
  LEDGER_FLEX_HASH_NOTE,
  LEDGER_FLEX_WRAP_NOTE,
  pixelWrap,
  renderLedgerFlexFlow,
  renderLedgerFlexHashFlow,
  type ILedgerFlexFlowParams,
} from './ledger-flex-preview'

// swapOwner(address,address,address) calldata; its uppercased `data` wraps to
// more than the 6-row preview budget, so the filmstrip truncates it with "…".
const SWAP_OWNER: Hex = ('0xe318b52b' +
  '000000000000000000000000' +
  '9740a8e0197689d144b19da4bdc9ef65fef11cda' +
  '000000000000000000000000' +
  'b137680000000000000000000000000000000000' +
  '000000000000000000000000' +
  '0000000000000000000000000000000000000001') as Hex

const PARAMS: ILedgerFlexFlowParams = {
  chainId: 34443,
  // lowercase on purpose — must be rendered EIP-55 checksummed
  verifyingContract: '0x031f25f640e0530a51f5617757b281a8df5614ee',
  to: '0x57c676a0417233a0bd3cbbb705db158d4261074b',
  value: '0',
  data: SWAP_OWNER,
}

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

describe('renderLedgerFlexFlow', () => {
  const flow = renderLedgerFlexFlow(PARAMS)
  const joined = flow.join('\n')

  it('renders the five signing screens in order', () => {
    expect(joined).toContain('Blind signing ahead') // warning
    expect(joined).toContain('Review typed') // 1/8
    expect(joined).toContain('EIP712Domain') // 2/8
    expect(joined).toContain('SafeTx') // 3/8
    expect(joined).toContain('data') // 4/8
    expect(joined).toContain('1 of 8')
    expect(joined).toContain('2 of 8')
    expect(joined).toContain('3 of 8')
    expect(joined).toContain('4 of 8')
  })

  it('omits the non-security-relevant screens 5–8', () => {
    expect(joined).not.toContain('5 of 8')
    expect(joined).not.toContain('nonce')
  })

  it('shows the domain values (checksummed, glyph-width wrapped)', () => {
    expect(joined).toContain('34443')
    // lowercase glyphs are narrower on-device, so 17 hex + 0x fit on row 1
    expect(joined).toContain('0x031f25F640E0530a5')
    expect(joined).not.toContain('0x031f25f640e0530a') // not the lowercase form
  })

  it('shows the SafeTx to (checksummed) and value', () => {
    expect(joined).toContain('0x57C676A0417233A0')
    expect(joined).toContain('Bd3Cbbb705Db158D42')
    expect(joined).toContain('value')
  })

  it('reproduces the glyph-width-wrapped data rows with truncation', () => {
    expect(joined).toContain('0xE318B52B00000000')
    expect(joined).toContain('000000000000000097')
    expect(joined).toContain('40A8E0197689D144B1')
    expect(joined).toContain('DA0000000000000000')
    expect(joined).toContain('00000000B137680000…')
    expect(joined).toContain('( More )')
  })

  it('highlights the "Accept risk and continue" action in bold green', () => {
    expect(joined).toContain(`${ESC}[1;32mAccept risk and${ESC}[0m`)
    expect(joined).toContain(`${ESC}[1;32mcontinue${ESC}[0m`)
  })

  it('renders the frame chrome (borders, Skip, Reject)', () => {
    expect(flow[0]).toContain('╭')
    expect(flow[flow.length - 1]).toContain('╰')
    expect(joined).toContain('Skip')
    expect(joined).toContain('Reject')
  })

  it('produces a rectangular block (all rows equal visible width)', () => {
    const widths = new Set(flow.map((l) => [...stripAnsi(l)].length))
    expect(widths.size).toBe(1)
  })

  it('stays rectangular when a value is at least the interior width', () => {
    // a ≥20-char value must not overflow the box border by one column
    const long = renderLedgerFlexFlow({ ...PARAMS, value: '1'.repeat(30) })
    const widths = new Set(long.map((l) => [...stripAnsi(l)].length))
    expect(widths.size).toBe(1)
  })

  it('does not show a "More" affordance when the data fits without truncation', () => {
    const short = renderLedgerFlexFlow({ ...PARAMS, data: '0xa9059cbb' as Hex })
    const j = short.join('\n')
    expect(j).toContain('0xA9059CBB')
    expect(j).not.toContain('( More )')
    expect(j).not.toContain('…')
  })
})

describe('LEDGER_FLEX_WRAP_NOTE', () => {
  it('is a red caveat about proportional-font line breaks', () => {
    expect(LEDGER_FLEX_WRAP_NOTE).toContain(`${ESC}[31m`)
    expect(LEDGER_FLEX_WRAP_NOTE).toContain(`${ESC}[0m`)
    expect(stripAnsi(LEDGER_FLEX_WRAP_NOTE).toLowerCase()).toContain('wrap')
  })
})

describe('pixelWrap (on-device glyph-width wrapping)', () => {
  // Per-line character counts captured on a physical Ledger Flex (EXSC-580):
  // each target is `0x` + 60 hex; line 1 includes the `0x` prefix. The pixel
  // model must reproduce these exactly for the uppercase `data` field.
  const CALIBRATION: [string, string, number[]][] = [
    ['digits', '0'.repeat(60), [18, 18, 18, 8]],
    ['A', 'A'.repeat(60), [16, 16, 16, 14]],
    ['B', 'B'.repeat(60), [17, 17, 17, 11]],
    ['C', 'C'.repeat(60), [16, 16, 16, 14]],
    ['D', 'D'.repeat(60), [16, 16, 16, 14]],
    ['E', 'E'.repeat(60), [18, 18, 18, 8]],
    ['F', 'F'.repeat(60), [19, 19, 19, 5]],
    ['0-9 ruler', '0123456789'.repeat(6), [18, 18, 18, 8]],
    ['0A alternating', '0A'.repeat(30), [17, 17, 17, 11]],
    [
      'realistic mixed',
      'E318B52B9740A8E0197689D144B19DA4BDC9EF65FEF11CDA000000000000',
      [18, 18, 18, 8],
    ],
  ]

  for (const [name, hex, counts] of CALIBRATION)
    it(`reproduces device line breaks: ${name}`, () => {
      const rows = pixelWrap(`0x${hex.toUpperCase()}`)
      expect(rows.map((r) => r.length)).toEqual(counts)
      expect(rows.join('')).toBe(`0x${hex.toUpperCase()}`)
    })

  it('never emits a row wider than the panel interior', () => {
    // an all-lowercase-f run is the narrowest glyph → most chars/line
    const rows = pixelWrap(`0x${'f'.repeat(120)}`)
    expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(19)
  })
})

describe('joinPanelsHorizontally', () => {
  it('concatenates equal-height panels with the given gap', () => {
    const out = joinPanelsHorizontally(
      [
        ['AA', 'BB'],
        ['CC', 'DD'],
      ],
      3
    )
    expect(out).toEqual(['AA   CC', 'BB   DD'])
  })

  it('pads missing lines of shorter panels with empty strings', () => {
    const out = joinPanelsHorizontally([['A', 'B', 'C'], ['X']], 1)
    expect(out).toEqual(['A X', 'B ', 'C '])
  })
})

const COMPARE_STYLE = `${ESC}[1;33m`

/** Every character the renderer wrapped in the compare style, in output order. */
const highlightedRuns = (lines: string[]): string => {
  const pattern = new RegExp(`${ESC}\\[1;33m([^${ESC}]*)${ESC}\\[0m`, 'g')
  return lines
    .flatMap((line) => [...line.matchAll(pattern)].map((m) => m[1] ?? ''))
    .join('')
}

const BOX_CHARS = '│╭╮╰╯'

/** Visible width of a row up to the last box border — the framed screens. */
const panelWidth = (line: string): number => {
  const plain = stripAnsi(line)
  let last = -1
  for (let i = 0; i < plain.length; i++)
    if (BOX_CHARS.includes(plain[i] as string)) last = i
  return last + 1
}

/**
 * One row of output split into the framed screens and the instruction column
 * printed beside them — the compare runs must be checked separately, since a
 * single row carries a slice of each.
 */
const splitRow = (line: string): { screens: string; column: string } => {
  // Walk the styled string so the split index accounts for the ANSI bytes.
  let visible = -1
  let cut = line.length
  const width = panelWidth(line)
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith(`${ESC}[`, i)) {
      i = line.indexOf('m', i)
      continue
    }
    visible++
    if (visible === width) {
      cut = i
      break
    }
  }
  return { screens: line.slice(0, cut), column: line.slice(cut) }
}

describe('applyStyleRanges', () => {
  const S = `${ESC}[1m`

  it('leaves text untouched with no ranges', () => {
    expect(applyStyleRanges('abcdef', [])).toBe('abcdef')
  })

  it('styles two disjoint runs and nothing between them', () => {
    expect(
      applyStyleRanges('abcdef', [
        { start: 0, end: 2, style: S },
        { start: 4, end: 6, style: S },
      ])
    ).toBe(`${S}ab${ESC}[0mcd${S}ef${ESC}[0m`)
  })

  it('applies ranges given out of order', () => {
    expect(
      applyStyleRanges('abcd', [
        { start: 2, end: 4, style: S },
        { start: 0, end: 1, style: S },
      ])
    ).toBe(`${S}a${ESC}[0mb${S}cd${ESC}[0m`)
  })

  it('clamps a range that runs past the end of the text', () => {
    expect(applyStyleRanges('ab', [{ start: 1, end: 99, style: S }])).toBe(
      `a${S}b${ESC}[0m`
    )
  })

  it('drops a range that starts past the end of the text', () => {
    expect(applyStyleRanges('ab', [{ start: 5, end: 9, style: S }])).toBe('ab')
  })

  // A replacement operand that contains the styled text makes `$&`, `` $` ``
  // and `$'` inside it expand as substitution patterns, widening the row past
  // the panel interior and breaking the frame the signer compares against the
  // device. Slicing cannot do that; this pins it so a rewrite via
  // `String.prototype.replace` fails here.
  it('treats substitution patterns in the text as literal characters', () => {
    for (const probe of ['$&$&$&', "a$'b", '$`x', '$1$2']) {
      const styled = applyStyleRanges(probe, [
        { start: 0, end: probe.length, style: S },
      ])

      expect(stripAnsi(styled)).toBe(probe)
    }
  })

  it('never changes the visible character count', () => {
    const text = 'abcdefghij'
    const styled = applyStyleRanges(text, [
      { start: 1, end: 3, style: S },
      { start: 7, end: 10, style: S },
    ])
    expect(stripAnsi(styled)).toBe(text)
  })
})

describe('renderLedgerFlexHashFlow', () => {
  const HASH =
    '0x1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'
  const flow = renderLedgerFlexHashFlow({ hash: HASH })
  const joined = flow.join('\n')

  it('renders the three message screens in order', () => {
    const plain = stripAnsi(joined)
    expect(plain).toContain('Review message')
    expect(plain).toContain('Swipe to review')
    expect(plain).toContain('Message')
    expect(plain).toContain('Sign message')
    expect(plain).toContain('Hold to sign')
    // Left to right, not top to bottom: the screens are columns of one row of
    // panels, so order is a column offset, never a line index.
    // Measured on the framed screens only: the instruction column beside them
    // names the "Message" screen too, and would be found first.
    const columnOf = (needle: string): number => {
      const screens = flow.map((line) => stripAnsi(splitRow(line).screens))
      const row = screens.find((line) => line.includes(needle))
      return row?.indexOf(needle) ?? -1
    }
    expect(columnOf('Review message')).toBeGreaterThan(-1)
    expect(columnOf('Review message')).toBeLessThan(columnOf('Message'))
    expect(columnOf('Message')).toBeLessThan(columnOf('Sign message'))
  })

  // Everything the preview shows is something read off a physical device. A
  // page counter or a per-screen affordance carried over from the typed-data
  // flow would be an invented detail the operator is asked to check against a
  // screen that may not carry it.
  //
  // A whitelist, not a denylist of the specific strings that were removed: the
  // property is "nothing beyond these lines appears", which a denylist cannot
  // express — reinstating a counter in different words (`< 1 / 3 >`, a `Cancel`
  // header) satisfies every "does not contain" assertion.
  it('shows nothing beyond the observed screen text and the hash', () => {
    const cells: string[] = []
    for (const line of flow) {
      const screens = stripAnsi(splitRow(line).screens)
      for (const cell of screens.split('│')) {
        const text = cell.trim()
        // Drop the frame itself: the top and bottom rows carry no '│' to split
        // on, so they arrive whole. '>' is the between-panel step marker.
        if (!text || text === '>' || /^[─╭╮╰╯\s]+$/.test(text)) continue
        cells.push(text)
      }
    }

    expect([...cells].sort()).toEqual(
      [
        'Review message',
        'Swipe to review',
        'Message',
        '0x1A2B3C4D5E6F7081',
        '9293A4B5C6D7E8F90A',
        '1B2C3D4E5F60718293',
        'A4B5C6D7E8F9',
        'Sign message',
        'Hold to sign',
      ].sort()
    )
  })

  it('renders the hash upper case, as the device does', () => {
    const plain = stripAnsi(joined).replace(/\s+/g, '')
    expect(plain).toContain('0x1A2B3C4D')
    expect(plain).not.toContain('1a2b3c4d')
  })

  // Pinned as a literal, not derived from HASH_COMPARE_CHARS: a mutation that
  // shortens the compared run to a grindable four-and-four must fail here
  // rather than move the expectation with it.
  it('compares 8 characters from each end', () => {
    expect(HASH_COMPARE_CHARS).toBe(8)
  })

  it('highlights exactly the first and last 8 hex characters on the screen', () => {
    const onScreen = flow.map((line) => splitRow(line).screens)

    expect(highlightedRuns(onScreen)).toBe('1A2B3C4DC6D7E8F9')
  })

  it('highlights the same two runs in the instruction column', () => {
    const hex = HASH.slice(2).toUpperCase()
    const beside = flow.map((line) => splitRow(line).column)

    expect(highlightedRuns(beside)).toBe(
      `${hex.slice(0, HASH_COMPARE_CHARS)}${hex.slice(-HASH_COMPARE_CHARS)}`
    )
  })

  // Row breaks follow measured per-glyph widths, so the hash's own characters
  // decide where they land. These are the width extremes: 'A' is the widest
  // glyph in the table and wraps into five rows, leaving a short final row that
  // splits the tail run across a break; 'F' is the narrowest. A run that
  // straddles a break must still come out exact, which is what the per-row span
  // intersection in `hashRows` is for.
  const WIDTH_EXTREMES: [string, string][] = [
    ['widest glyphs', 'A'.repeat(64)],
    ['narrowest glyphs', 'F'.repeat(64)],
    ['wide then narrow', `${'A'.repeat(32)}${'F'.repeat(32)}`],
    ['narrow then wide', `${'F'.repeat(32)}${'A'.repeat(32)}`],
    ['all digits', '0'.repeat(64)],
  ]

  for (const [label, hex] of WIDTH_EXTREMES)
    it(`highlights both ends with ${label}, wherever the rows break`, () => {
      const onScreen = renderLedgerFlexHashFlow({ hash: `0x${hex}` }).map(
        (line) => splitRow(line).screens
      )

      expect(highlightedRuns(onScreen)).toBe(
        `${hex.slice(0, HASH_COMPARE_CHARS)}${hex.slice(-HASH_COMPARE_CHARS)}`
      )
    })

  // Guards the cases above against proving nothing: if no hash reached the
  // renderer's multi-row path, the span intersection went untested.
  it('splits a compare run across a line break when the rows fall that way', () => {
    const pattern = new RegExp(`${ESC}\\[1;33m([^${ESC}]*)${ESC}\\[0m`, 'g')
    const onScreen = renderLedgerFlexHashFlow({
      hash: `0x${'A'.repeat(64)}`,
    }).map((line) => splitRow(line).screens)

    expect(
      onScreen.flatMap((line) => [...line.matchAll(pattern)]).length
    ).toBeGreaterThan(2)
  })

  it('names the 16 characters to compare beside the screens', () => {
    const plain = stripAnsi(joined)
    expect(plain).toContain('COMPARE THESE 16 CHARACTERS')
    expect(plain).toContain('first 8')
    expect(plain).toContain('last 8')
    expect(plain.toLowerCase()).toContain('dm from the proposer')
  })

  it('keeps every screen row the same visible width despite the styling', () => {
    // The compare column is unframed and trails the panels, so widths are
    // measured up to the last box border on each row.
    expect(new Set(flow.map(panelWidth)).size).toBe(1)
  })

  it('styles the hash on the device screen, not only in the column', () => {
    const styledScreenRows = flow.filter((line) =>
      splitRow(line).screens.includes(COMPARE_STYLE)
    )
    expect(styledScreenRows.length).toBeGreaterThan(0)
  })

  const REJECTED: [string, string][] = [
    ['too short', `0x${'a'.repeat(63)}`],
    ['too long', `0x${'a'.repeat(65)}`],
    ['not hex', `0x${'g'.repeat(64)}`],
    ['unprefixed', 'a'.repeat(64)],
    ['empty', ''],
    ['an address', '0x031f25f640e0530a51f5617757b281a8df5614ee'],
    // Unreachable from the production caller, whose `bytes32` read can only
    // decode to the accepted shape. Kept as a shape invariant on an exported
    // function: a caller passing row-derived text is refused, not framed.
    ['ansi escapes', `0x${ESC}[31m${'a'.repeat(58)}${ESC}[0m`],
    ['box drawing', `0x${'│'.repeat(64)}`],
  ]

  for (const [label, value] of REJECTED)
    it(`refuses to render ${label}`, () => {
      expect(() => renderLedgerFlexHashFlow({ hash: value })).toThrow(
        /Expected a Safe transaction hash/
      )
    })
})

describe('LEDGER_FLEX_HASH_NOTE', () => {
  it('is a red caveat about case and line breaks', () => {
    expect(LEDGER_FLEX_HASH_NOTE).toContain(`${ESC}[31m`)
    expect(LEDGER_FLEX_HASH_NOTE).toContain(`${ESC}[0m`)
    const plain = stripAnsi(LEDGER_FLEX_HASH_NOTE).toLowerCase()
    expect(plain).toContain('case')
    expect(plain).toContain('wrap')
  })

  // The screens omit navigation the device may well show. Unsaid, that omission
  // is a false alarm of its own — the signer sees more on the Flex than in the
  // terminal and cannot tell an expected extra from a real difference.
  it('says that navigation the preview omits is expected', () => {
    const plain = stripAnsi(LEDGER_FLEX_HASH_NOTE).toLowerCase()

    expect(plain).toContain('not a mismatch')
    expect(plain).toContain('navigation')
  })
})

describe('the filmstrip cannot be driven by the stored calldata', () => {
  /** Everything this module writes itself; nothing else may remain. */
  // eslint-disable-next-line no-control-regex -- these are the codes the module writes
  const OWN_STYLES = /\u001b\[(?:0|1|31|33|1;32)m/gu
  // eslint-disable-next-line no-control-regex -- finding the escapes is the point
  const TERMINAL_DRIVING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

  it('renders a benign payload byte for byte as before', () => {
    // The filmstrip is what the signer compares against the device, so the
    // benign rendering is the thing that must not move. Panels only: a benign
    // payload adds no notice line.
    const lines = renderLedgerFlexFlow(PARAMS)
    expect(lines.length).toBe(17)
    expect(lines[lines.length - 1]?.startsWith('╰')).toBe(true)
    expect(lines.join('\n')).toContain('0xE318B52B000000')
  })

  it('leaves no escape from the row anywhere in the output', () => {
    const lines = renderLedgerFlexFlow({
      ...PARAMS,
      data: `0x${ESC}[2J${ESC}[Hdeadbeef`,
    })

    for (const line of lines)
      expect(line.replace(OWN_STYLES, '').match(TERMINAL_DRIVING)).toBeNull()
    // Paired present: the row is still rendered, inert, not silently dropped.
    expect(lines.join('\n')).toContain('0x[2J[HDEADBEEF')
  })

  it('discloses below the panels what it had to repair', () => {
    const lines = renderLedgerFlexFlow({
      ...PARAMS,
      data: `0x${ESC}[2J${ESC}[Hdeadbeef`,
    })

    expect(lines[lines.length - 1]).toBe(
      '\u001b[33m ⚠ sanitised for display — stored 17, printable 15\u001b[0m\u001b[31m ⚠ the stored calldata is not 0x-prefixed hex — your device will not show this\u001b[0m'
    )
    // Below, never inside: a notice threaded through a panel would break the
    // geometry the character-by-character comparison depends on.
    expect(lines[lines.length - 2]?.startsWith('╰')).toBe(true)
  })

  it('flags calldata that is not hex even when it needs no sanitising', () => {
    const lines = renderLedgerFlexFlow({ ...PARAMS, data: 'not calldata' })

    expect(lines[lines.length - 1]).toBe(
      '\u001b[31m ⚠ the stored calldata is not 0x-prefixed hex — your device will not show this\u001b[0m'
    )
  })

  it('takes the field as stored, not as Hex', () => {
    // Nothing coerces `data` on the way here, so a row can hold any type.
    const build = (): string[] =>
      renderLedgerFlexFlow({ ...PARAMS, data: { nope: true } })
    expect(build).not.toThrow()
    expect(build()[build().length - 1]).toContain('not 0x-prefixed hex')
  })

  it('stays rectangular with an escape-bearing payload', () => {
    const lines = renderLedgerFlexFlow({
      ...PARAMS,
      data: `0x${ESC}[2J${ESC}[Hdeadbeef`,
    })
    const widths = new Set(
      lines
        .filter((line) => line.startsWith('│') || line.startsWith('╭'))
        .map((line) => [...line.replace(OWN_STYLES, '')].length)
    )
    expect(widths.size).toBe(1)
  })
})
