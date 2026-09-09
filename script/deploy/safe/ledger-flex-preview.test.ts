// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { type Hex } from 'viem'

import {
  joinPanelsHorizontally,
  LEDGER_FLEX_WRAP_NOTE,
  pixelWrap,
  renderLedgerFlexFlow,
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
