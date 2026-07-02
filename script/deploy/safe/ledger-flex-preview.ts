/**
 * Ledger Flex signing filmstrip
 *
 * Renders an ASCII replica of the sequence of Ledger Flex screens a signer
 * steps through when blind-signing a Safe transaction (EIP-712), populated with
 * the actual to-be-signed values. Import from `confirm-safe-tx.ts` to print the
 * filmstrip so the operator can compare each screen against the physical device
 * instead of eyeballing a 200-character hex blob.
 *
 * Only the first five screens are reproduced (warning + screens 1–4 of 8): the
 * security-relevant ones — domain chainId/verifyingContract, SafeTx to/value,
 * and the calldata. Screens 5–8 (safeTxGas, baseGas, gasPrice, gasToken,
 * refundReceiver, nonce) are boilerplate — typically zero and not worth
 * comparing — so they are intentionally omitted.
 */

import { getAddress, type Hex } from 'viem'

const INNER = 20 // interior width of each screen box (between the borders)
const PANEL_GAP = 2 // spaces between panels in the row
// On-device the `data` preview shows ~6 proportional-font rows before the "…".
const DATA_PREVIEW_ROWS = 6
// A row can never exceed the panel interior (1-space left margin + text).
const MAX_ROW_CHARS = INNER - 1

// The Flex wraps hex by PIXEL width, not character count. These are per-glyph
// advance widths measured on-device (digit normalized to 1.0, EXSC-580 spike);
// greedy-filling to LINE_BUDGET reproduces the device's `data` (uppercase) line
// breaks exactly. Lowercase a-f are a best-guess — the device force-uppercases
// the `data` field, so they can't be measured there, which makes ADDRESS-field
// wrapping approximate (see LEDGER_FLEX_WRAP_NOTE). Unlisted glyphs fall back to 1.
const LINE_BUDGET = 18.8 // digit-widths per line (measured range [18.60, 19.0))
const GLYPH_WIDTH: Record<string, number> = {
  '0': 1,
  '1': 1,
  '2': 1,
  '3': 1,
  '4': 1,
  '5': 1,
  '6': 1,
  '7': 1,
  '8': 1,
  '9': 1,
  x: 1,
  A: 1.12,
  B: 1.06,
  C: 1.12,
  D: 1.12,
  E: 1.0,
  F: 0.95,
  a: 0.9,
  b: 0.95,
  c: 0.9,
  d: 0.95,
  e: 0.9,
  f: 0.85,
}

// Bold green, to flag on the terminal side that "Accept risk and continue" is
// the action the operator must tap to proceed (the device renders it plainly).
const ESC = String.fromCharCode(27)
const HIGHLIGHT = `${ESC}[1;32m`
const BOLD = `${ESC}[1m`
const RED = `${ESC}[31m`
const RESET = `${ESC}[0m`

/**
 * Caveat to print BELOW the filmstrip. Rows are wrapped with measured on-device
 * glyph widths, so the `data` field's breaks match the Ledger; address fields
 * use best-guess lowercase widths and may wrap a character or two differently.
 * Either way the character SEQUENCE matches 1:1 — the authoritative check.
 */
export const LEDGER_FLEX_WRAP_NOTE = `${RED}⚠ Address lines may wrap slightly differently on your Ledger — compare the character sequence, not the line breaks.${RESET}`

interface IFlexLine {
  text: string
  align: 'left' | 'center'
  /** Optional ANSI style applied to the text (not the padding). */
  style?: string
}

interface IFlexScreen {
  /** Right-aligned top affordance (e.g. "Skip"); empty for none. */
  header: string
  content: IFlexLine[]
  /** Pre-formatted, exactly `INNER`-wide bottom line (nav / tap area). */
  footer: string
}

export interface ILedgerFlexFlowParams {
  chainId: number
  /** EIP-712 domain verifyingContract — the Safe address. */
  verifyingContract: string
  /** SafeTx `to` target. */
  to: string
  /** SafeTx `value`, decimal string. */
  value: string
  /** SafeTx `data` calldata, `0x`-prefixed. */
  data: Hex
}

/**
 * Greedy-fill a hex string into on-device rows by cumulative glyph width,
 * mirroring how the Flex wraps proportional-font hex. Capped at MAX_ROW_CHARS
 * so a row can never overflow the ASCII panel.
 */
export const pixelWrap = (display: string): string[] => {
  const rows: string[] = []
  let cur = ''
  let width = 0
  for (const ch of display) {
    const w = GLYPH_WIDTH[ch] ?? 1
    if (
      cur !== '' &&
      (width + w > LINE_BUDGET || cur.length >= MAX_ROW_CHARS)
    ) {
      rows.push(cur)
      cur = ch
      width = w
    } else {
      cur += ch
      width += w
    }
  }
  if (cur !== '') rows.push(cur)
  return rows.length ? rows : ['']
}

/** Word-wrap prose to `width`, hard-splitting any word longer than `width`. */
const wrapWords = (text: string, width: number): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    let w = word
    while (w.length > width) {
      if (line) {
        out.push(line)
        line = ''
      }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ` ${w}`
    else {
      out.push(line)
      line = w
    }
  }
  if (line) out.push(line)
  return out
}

/**
 * Rows for the Ledger `data` field: uppercased hex with a lowercase `0x`
 * prefix, wrapped by on-device glyph width, truncated with a trailing "…" past
 * the device's ~6-row preview budget.
 */
const dataRows = (data: Hex): { rows: string[]; truncated: boolean } => {
  const display = `0x${data.replace(/^0x/i, '').toUpperCase()}`
  const all = pixelWrap(display)
  const truncated = all.length > DATA_PREVIEW_ROWS
  const rows = truncated ? all.slice(0, DATA_PREVIEW_ROWS) : all
  if (truncated) {
    const last = rows.length - 1
    // leave room for the ellipsis so it can't overflow the panel
    const lastRow = rows[last] ?? ''
    rows[last] =
      (lastRow.length >= MAX_ROW_CHARS
        ? lastRow.slice(0, MAX_ROW_CHARS - 1)
        : lastRow) + '…'
  }
  return { rows, truncated }
}

// Address fields render EIP-55 checksummed (mixed case), unlike the uppercased
// `data` field. Wrapped by the same on-device glyph widths; lowercase a-f use
// best-guess widths, so address breaks are approximate (LEDGER_FLEX_WRAP_NOTE).
const addressRows = (addr: string): string[] =>
  pixelWrap(getAddress(addr as Hex))

const navFooter = (page: number): string => {
  const left = 'Reject'
  const right = `< ${page} of 8 >`
  const gap = Math.max(1, INNER - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}`
}

const buildScreens = (p: ILedgerFlexFlowParams): IFlexScreen[] => {
  const { rows, truncated } = dataRows(p.data)

  const warning: IFlexScreen = {
    header: '',
    content: [
      { text: '/!\\', align: 'center' },
      { text: '', align: 'center' },
      { text: 'Blind signing ahead', align: 'center', style: BOLD },
      { text: '', align: 'center' },
      ...wrapWords(
        'If you sign this transaction, you could lose your assets.',
        INNER - 2
      ).map((text) => ({ text, align: 'left' as const })),
      { text: '', align: 'center' },
      { text: '[ Back to safety ]', align: 'center' },
      { text: '', align: 'center' },
      { text: 'Accept risk and', align: 'center', style: HIGHLIGHT },
      { text: 'continue', align: 'center', style: HIGHLIGHT },
    ],
    footer: '',
  }

  const typedMessage: IFlexScreen = {
    header: '',
    content: [
      { text: '[=]', align: 'center' },
      { text: '', align: 'center' },
      { text: 'Review typed', align: 'center', style: BOLD },
      { text: 'message', align: 'center', style: BOLD },
      { text: '', align: 'center' },
      { text: 'Blind signing', align: 'left' },
      { text: 'required.', align: 'left' },
    ],
    footer: navFooter(1),
  }

  const domain: IFlexScreen = {
    header: 'Skip',
    content: [
      { text: 'Review struct', align: 'left', style: BOLD },
      { text: 'EIP712Domain', align: 'left' },
      { text: '', align: 'left' },
      { text: 'chainId', align: 'left', style: BOLD },
      { text: String(p.chainId), align: 'left' },
      { text: '', align: 'left' },
      { text: 'verifyingContract', align: 'left', style: BOLD },
      ...addressRows(p.verifyingContract).map((text) => ({
        text,
        align: 'left' as const,
      })),
    ],
    footer: navFooter(2),
  }

  const safeTx: IFlexScreen = {
    header: 'Skip',
    content: [
      { text: 'Review struct', align: 'left', style: BOLD },
      { text: 'SafeTx', align: 'left' },
      { text: '', align: 'left' },
      { text: 'to', align: 'left', style: BOLD },
      ...addressRows(p.to).map((text) => ({ text, align: 'left' as const })),
      { text: '', align: 'left' },
      { text: 'value', align: 'left', style: BOLD },
      { text: p.value, align: 'left' },
    ],
    footer: navFooter(3),
  }

  const dataScreen: IFlexScreen = {
    header: 'Skip',
    content: [
      { text: 'data', align: 'left', style: BOLD },
      ...rows.map((text) => ({ text, align: 'left' as const })),
      ...(truncated
        ? [
            { text: '', align: 'center' as const },
            { text: '( More )', align: 'center' as const },
          ]
        : []),
    ],
    footer: navFooter(4),
  }

  return [warning, typedMessage, domain, safeTx, dataScreen]
}

/** One interior row, clipped/padded to `INNER` with a 1-space side margin. */
const frameLine = ({ text, align, style }: IFlexLine): string => {
  const t = text.length > INNER ? text.slice(0, INNER) : text
  let body: string
  if (align === 'center') {
    const space = INNER - t.length
    const left = Math.floor(space / 2)
    body = ' '.repeat(left) + t + ' '.repeat(space - left)
  } else {
    // slice before padEnd: a 1-space margin + INNER-length text would be
    // INNER+1 wide, and padEnd never truncates — breaking the row width.
    body = ` ${t}`.slice(0, INNER).padEnd(INNER)
  }
  // Style only the text run so the padding (and thus the visible width) is
  // untouched — keeps the box borders and neighbouring panels aligned.
  if (style && t) body = body.replace(t, `${style}${t}${RESET}`)
  return `│${body}│`
}

/** A row whose content is already exactly `INNER`-wide (footers, blanks). */
const frameRaw = (raw: string): string =>
  `│${raw.padEnd(INNER).slice(0, INNER)}│`

const framePanel = (screen: IFlexScreen, contentHeight: number): string[] => {
  const top = `╭${'─'.repeat(INNER)}╮`
  const bottom = `╰${'─'.repeat(INNER)}╯`
  const headerLine = screen.header
    ? frameRaw(`${screen.header} `.padStart(INNER))
    : frameRaw('')

  // Centre the content vertically between the header and footer: split the
  // slack evenly instead of dumping it all at the bottom (which made the
  // shorter screens look top-heavy).
  const slack = Math.max(0, contentHeight - screen.content.length)
  const topPad = Math.floor(slack / 2)
  const blank = () => frameRaw('')

  return [
    top,
    headerLine,
    ...Array.from({ length: topPad }, blank),
    ...screen.content.map(frameLine),
    ...Array.from({ length: slack - topPad }, blank),
    frameRaw(screen.footer),
    bottom,
  ]
}

/** Concatenate equal-height panels left-to-right, separated by `gap` spaces. */
export const joinPanelsHorizontally = (
  panels: string[][],
  gap: number = PANEL_GAP
): string[] => {
  const height = Math.max(...panels.map((p) => p.length))
  const sep = ' '.repeat(gap)
  const out: string[] = []
  for (let i = 0; i < height; i++)
    out.push(panels.map((p) => p[i] ?? '').join(sep))
  return out
}

/**
 * Render the Ledger Flex signing filmstrip for a Safe transaction.
 *
 * @param params - The to-be-signed domain and SafeTx values.
 * @returns The filmstrip as an array of lines (a row of five framed screens).
 * @throws If `verifyingContract` or `to` is not a valid EVM address — callers
 *   must gate on EVM networks (the Flex EIP-712 flow does not apply to Tron).
 */
export const renderLedgerFlexFlow = (
  params: ILedgerFlexFlowParams
): string[] => {
  const screens = buildScreens(params)
  const contentHeight = Math.max(...screens.map((s) => s.content.length))
  const panels = screens.map((s) => framePanel(s, contentHeight))

  // A vertically-centred ">" between panels shows the left-to-right order the
  // signer steps through the screens.
  const height = panels[0]?.length ?? 0
  const mid = Math.floor(height / 2)
  const connector = Array.from({ length: height }, (_, i) =>
    i === mid ? '>' : ' '
  )
  const withArrows = panels.flatMap((panel, i) =>
    i === 0 ? [panel] : [connector, panel]
  )
  return joinPanelsHorizontally(withArrows, 1)
}
