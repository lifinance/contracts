/**
 * Ledger Flex signing filmstrip
 *
 * Renders an ASCII replica of the sequence of Ledger Flex screens a signer
 * steps through, populated with the actual to-be-signed values, so the operator
 * compares each screen against the physical device instead of eyeballing a
 * 200-character hex blob. Import from `confirm-safe-tx.ts`.
 *
 * Two flows, one per signing mode. `renderLedgerFlexHashFlow` covers the
 * default hash mode, where the device signs the Safe transaction hash as a
 * message; `renderLedgerFlexFlow` covers the opt-in EIP-712 mode below.
 *
 * In the EIP-712 flow only the first five screens are reproduced (warning +
 * screens 1–4 of 8): the
 * security-relevant ones — domain chainId/verifyingContract, SafeTx to/value,
 * and the calldata. Screens 5–8 (safeTxGas, baseGas, gasPrice, gasToken,
 * refundReceiver, nonce) are boilerplate — typically zero and not worth
 * comparing — so they are intentionally omitted.
 */

import { getAddress, type Hex } from 'viem'

import { asPrintable, UNBOUNDED } from './printable-field'

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
  // Uniform, and fitted to a single photographed hash (2026-09-12) rather than
  // to a measurement sweep: that one wrap constrains the value to (0.95, 0.975]
  // but says nothing about how the six glyphs differ from each other, so six
  // distinct numbers would claim precision the evidence does not carry.
  a: 0.97,
  b: 0.97,
  c: 0.97,
  d: 0.97,
  e: 0.97,
  f: 0.97,
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

/** A styled run of `text`, by character index — `[start, end)`. */
interface IFlexStyleRange {
  start: number
  end: number
  style: string
}

interface IFlexLine {
  text: string
  align: 'left' | 'center'
  /** Optional ANSI style applied to the text (not the padding). */
  style?: string
  /**
   * Styled runs within `text`. Needed where part of a row carries its own
   * emphasis — the two ends of the hash the signer compares sit mid-row.
   */
  ranges?: IFlexStyleRange[]
}

interface IFlexScreen {
  /** Right-aligned top affordance (e.g. "Skip"); empty for none. */
  header: string
  content: IFlexLine[]
  /** Pre-formatted, exactly `INNER`-wide bottom line (nav / tap area). */
  footer: string
  /** Vertical placement of `content`; centred unless pinned to the top. */
  anchor?: 'top'
}

export interface ILedgerFlexFlowParams {
  chainId: number
  /** EIP-712 domain verifyingContract — the Safe address. */
  verifyingContract: string
  /** SafeTx `to` target. */
  to: string
  /** SafeTx `value`, decimal string. */
  value: string
  /**
   * SafeTx `data` as the row stores it. Deliberately `unknown`: it reaches the
   * signed struct through a cast, so it can hold anything at runtime, and a
   * caller that pre-rendered it would leave this module unable to say so.
   */
  data: unknown
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

/** The shape a calldata field has when it is calldata. */
const HEX_CALLDATA = /^0x[0-9a-f]*$/iu

/**
 * Rows for the Ledger `data` field: uppercased hex with a lowercase `0x`
 * prefix, wrapped by on-device glyph width, truncated with a trailing "…" past
 * the device's ~6-row preview budget.
 *
 * The field arrives as the row stored it, not as `Hex`: nothing coerces it on
 * the way here, and the panel's own geometry settles nothing — `frameLine`
 * clips at 20 characters and `ESC[2J` is four, so an escape would sit inside a
 * row that still measures the right width. Hence the primitive below rather
 * than the wrapping. This filmstrip is the artefact the signer is told to
 * compare against the physical device, so text injected into it attacks the
 * verification step itself.
 *
 * A value that is not `0x`-prefixed hex is reported rather than repaired: which
 * bytes the row holds is the whole question here, so nothing may quietly change
 * them.
 */
const dataRows = (
  data: unknown
): { rows: string[]; truncated: boolean; notice: string } => {
  const { text, notice } = asPrintable(data, UNBOUNDED)
  const remarks = notice ? [notice] : []
  if (!HEX_CALLDATA.test(text))
    remarks.push(
      `${RED} ⚠ the stored calldata is not 0x-prefixed hex — your device will not show this${RESET}`
    )
  // Case-folding a value that is not hex would show the signer characters the
  // row does not hold, on the one panel whose job is a character comparison.
  const display = HEX_CALLDATA.test(text)
    ? `0x${text.replace(/^0x/i, '').toUpperCase()}`
    : text
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
  return { rows, truncated, notice: remarks.join('') }
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

const buildScreens = (
  p: ILedgerFlexFlowParams
): { screens: IFlexScreen[]; notice: string } => {
  const { rows, truncated, notice } = dataRows(p.data)

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

  return {
    screens: [warning, typedMessage, domain, safeTx, dataScreen],
    notice,
  }
}

/**
 * Wraps the given index ranges of `text` in their ANSI styles.
 *
 * Ranges are applied left to right over the ORIGINAL indices and clamped to the
 * string, so a range that survived a row clip cannot reach past its end. Only
 * the styled runs gain bytes; the visible character count is unchanged, which
 * is what keeps the panel borders aligned.
 *
 * Built from slices rather than `String.prototype.replace`: a replacement
 * operand containing the styled text makes `$&`, `` $` `` and `$'` inside that
 * text expand as substitution patterns, which widens the row and breaks the
 * frame the signer is comparing against their device.
 *
 * @param text - The unstyled row text.
 * @param ranges - Half-open `[start, end)` index ranges and the style each carries.
 * @returns The same characters with ANSI styles wrapped around the given ranges.
 */
export const applyStyleRanges = (
  text: string,
  ranges: IFlexStyleRange[]
): string => {
  if (!ranges.length) return text

  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const range of sorted) {
    const start = Math.max(cursor, Math.min(range.start, text.length))
    const end = Math.max(start, Math.min(range.end, text.length))
    if (end === start) continue
    out += `${text.slice(cursor, start)}${range.style}${text.slice(
      start,
      end
    )}${RESET}`
    cursor = end
  }
  return out + text.slice(cursor)
}

/** One interior row, clipped/padded to `INNER` with a 1-space side margin. */
const frameLine = ({ text, align, style, ranges }: IFlexLine): string => {
  const t = text.length > INNER ? text.slice(0, INNER) : text
  let body: string
  let offset: number
  if (align === 'center') {
    const space = INNER - t.length
    const left = Math.floor(space / 2)
    body = ' '.repeat(left) + t + ' '.repeat(space - left)
    offset = left
  } else {
    // slice before padEnd: a 1-space margin + INNER-length text would be
    // INNER+1 wide, and padEnd never truncates — breaking the row width.
    body = ` ${t}`.slice(0, INNER).padEnd(INNER)
    offset = 1
  }
  // Style only the text runs so the padding (and thus the visible width) is
  // untouched — keeps the box borders and neighbouring panels aligned.
  const shifted: IFlexStyleRange[] = []
  if (style && t) shifted.push({ start: offset, end: offset + t.length, style })
  for (const range of ranges ?? [])
    shifted.push({
      start: offset + range.start,
      end: offset + Math.min(range.end, t.length),
      style: range.style,
    })
  if (shifted.length) body = applyStyleRanges(body, shifted)
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
  // shorter screens look top-heavy). `anchor: 'top'` opts out, for a screen the
  // device itself fills from the top — its Message label sits against the top
  // edge, not floating in the middle.
  const slack = Math.max(0, contentHeight - screen.content.length)
  const topPad = screen.anchor === 'top' ? 0 : Math.floor(slack / 2)
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
  const { screens, notice } = buildScreens(params)
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
  const panelLines = joinPanelsHorizontally(withArrows, 1)
  // Below the panels, never inside one: the boxes are exactly `INNER` wide and
  // a notice threaded through them would break the geometry the comparison
  // depends on.
  return notice ? [...panelLines, notice] : panelLines
}

/**
 * Hex characters from each end of the hash the signer compares.
 *
 * The locked figure is 16 characters, eight from each end: four-and-four is
 * grindable at 2^32 by an attacker who controls the malicious payload's cheap
 * fields, so a shorter comparison is not a weaker check but no check.
 */
export const HASH_COMPARE_CHARS = 8

// Bold yellow, used for nothing else in the filmstrip: the two runs the signer
// must actually read carry a colour no other field can be confused with.
const COMPARE = `${ESC}[1;33m`

/** Caveat to print BELOW the hash filmstrip. */
export const LEDGER_FLEX_HASH_NOTE = [
  `${RED}⚠ The device may wrap the hash differently — compare the characters, not the line breaks.${RESET}`,
  `${RED}⚠ Only the titles, the prompt on each screen, the hash and the bottom bar are reproduced. Anything the device adds around them is expected, not a mismatch.${RESET}`,
].join('\n')

export interface ILedgerFlexHashFlowParams {
  /** The Safe transaction hash the device will be asked to sign, as 0x + 64 hex. */
  hash: string
}

const HASH_HEX_CHARS = 64

/** Screens the device pages through in hash mode, as its own counter reports. */
const HASH_SCREEN_COUNT = 3

/**
 * Interior rows, chosen so the box reads portrait like the device rather than
 * landscape: a terminal cell is about twice as tall as it is wide, so an
 * `INNER`-wide box needs roughly `INNER / 1.6` rows to look the shape a Flex is.
 */
const HASH_PANEL_MIN_CONTENT_ROWS = 11

/**
 * The document glyph the Flex shows above "Review message" and "Sign message?".
 *
 * Indicative, not a reproduction: the icon is on screen, so omitting it made the
 * replica emptier than the device, but its exact artwork was not measured and a
 * character sketch is the honest amount of detail to claim.
 */
const DOCUMENT_ICON: IFlexLine[] = [
  { text: '╔═══╗', align: 'center' },
  // Double-ruled deliberately: a light '│' here is the same character as the
  // panel border, so anything splitting a row on the frame cuts the icon in
  // half, and a reader's eye does the same.
  { text: '║ ≡ ║', align: 'center' },
  { text: '╚═══╝', align: 'center' },
]

/**
 * The hash as the device shows it, split into rows, each row carrying the
 * styled runs that fall inside it.
 *
 * The two compare runs are located in the unwrapped display string and then
 * intersected with each row, so they stay correct however the row breaks land —
 * including the case where one run spans two rows.
 */
const hashRows = (hash: string): IFlexLine[] => {
  // Lower case, photographed on a Flex 2026-09-12. The uppercasing this line
  // used to do was inherited from the `data` field, which the device really
  // does force-uppercase; the hash-mode Message screen does not.
  const display = `0x${hash.slice(2).toLowerCase()}`
  const spans = [
    { start: 2, end: 2 + HASH_COMPARE_CHARS },
    { start: display.length - HASH_COMPARE_CHARS, end: display.length },
  ]

  let consumed = 0
  return pixelWrap(display).map((text) => {
    const ranges: { start: number; end: number; style: string }[] = []
    for (const span of spans) {
      const start = Math.max(span.start, consumed)
      const end = Math.min(span.end, consumed + text.length)
      if (end > start)
        ranges.push({
          start: start - consumed,
          end: end - consumed,
          style: COMPARE,
        })
    }
    consumed += text.length
    return { text, align: 'left' as const, ranges }
  })
}

/** The bottom bar: "Reject" left, the page counter right, exactly `INNER` wide. */
const navBar = (page: number): string => {
  const left = ' Reject'
  const right = `< ${page} of ${HASH_SCREEN_COUNT} >`
  return `${left}${' '.repeat(
    Math.max(1, INNER - left.length - right.length)
  )}${right}`.slice(0, INNER)
}

/**
 * The three screens, carrying only what has been read off a physical Flex: the
 * titles, the prompt on each, the hash itself, and the bottom bar.
 *
 * The bar was photographed on 2026-09-12 and shows "Reject" beside a
 * "< n of 3 >" counter on all three screens. An earlier round removed both,
 * having inherited them from the typed-data flow rather than measuring them —
 * the right instinct applied to the wrong elements, since these two are real and
 * only the "Skip" header was invented. The preview exists so that a difference
 * from the device reads as an alarm, which holds only while everything in it is
 * known to be true; an element that is genuinely on screen and missing here
 * teaches the same shrug as one that is invented.
 */
const buildHashScreens = (hash: string): IFlexScreen[] => [
  {
    header: '',
    content: [
      ...DOCUMENT_ICON,
      { text: '', align: 'center' },
      { text: 'Review message', align: 'center', style: BOLD },
      { text: 'Swipe to review', align: 'center' },
    ],
    footer: navBar(1),
  },
  {
    header: '',
    content: [
      // Not bold: on the device this label is the quietest thing on the screen
      // and the hash is the loudest. Bolding it here inverted that.
      { text: 'Message', align: 'left' },
      ...hashRows(hash),
    ],
    footer: navBar(2),
    anchor: 'top',
  },
  {
    header: '',
    content: [
      ...DOCUMENT_ICON,
      { text: '', align: 'center' },
      { text: 'Sign message?', align: 'center', style: BOLD },
      { text: '', align: 'center' },
      { text: `${'─'.repeat(INNER - 2)}`, align: 'center' },
      { text: '', align: 'center' },
      { text: 'Hold to sign    (✓)', align: 'left', style: HIGHLIGHT },
    ],
    footer: navBar(3),
  },
]

/**
 * The instruction column printed to the right of the screens: what to compare,
 * and the two runs to compare, in the same colour they carry on screen 2.
 *
 * Lower case, which is what the device shows in hash mode and also what the rest
 * of the terminal prints — so the operator compares the same characters against
 * the screen and against the log, with no case difference to wave away.
 */
const compareColumn = (hash: string, height: number): string[] => {
  const hex = hash.slice(2).toLowerCase()
  const runs: [string, string] = [
    hex.slice(0, HASH_COMPARE_CHARS),
    hex.slice(-HASH_COMPARE_CHARS),
  ]

  // Nothing follows this column, so the lines carry their own left gap and need
  // no right padding.
  const lines = [
    `${BOLD}CHECK THESE 16 CHARACTERS${RESET}`,
    `${BOLD}on the "Message" screen${RESET}`,
    '',
    `  first 8   ${COMPARE}${runs[0]}${RESET}`,
    `  last 8    ${COMPARE}${runs[1]}${RESET}`,
    '',
    `${BOLD}Match them against the hash${RESET}`,
    `${BOLD}the proposer sent you${RESET}`,
    `${BOLD}directly — Slack DM, Signal,${RESET}`,
    `${BOLD}in person. Not this screen.${RESET}`,
    '',
    `8 from each end, not 4: whoever`,
    `wrote the payload could build`,
    `another transaction that starts`,
    `and ends the same way.`,
  ].map((line) => `   ${line}`)

  const slack = Math.max(0, height - lines.length)
  const top = Math.floor(slack / 2)
  return [
    ...Array.from({ length: top }, () => ''),
    ...lines,
    ...Array.from({ length: slack - top }, () => ''),
  ]
}

/**
 * Render the Ledger Flex filmstrip for hash-mode signing.
 *
 * @param params - The Safe transaction hash the device will sign.
 * @returns The filmstrip as an array of lines: three framed screens followed by
 *   the compare instruction column.
 * @throws If `hash` is not 0x + 64 hex characters. A shape invariant on an
 *   exported function, not an operator-facing sanitiser: the only production
 *   caller reads the hash from the Safe's `getTransactionHash`, whose `bytes32`
 *   return can only decode to that shape, so this cannot fire from there.
 */
export const renderLedgerFlexHashFlow = (
  params: ILedgerFlexHashFlowParams
): string[] => {
  if (!new RegExp(`^0x[0-9a-fA-F]{${HASH_HEX_CHARS}}$`).test(params.hash))
    throw new Error(
      `Expected a Safe transaction hash as 0x + ${HASH_HEX_CHARS} hex characters, got ${params.hash.length} characters`
    )

  const screens = buildHashScreens(params.hash)
  const contentHeight = Math.max(
    HASH_PANEL_MIN_CONTENT_ROWS,
    ...screens.map((s) => s.content.length)
  )
  const panels = screens.map((s) => framePanel(s, contentHeight))

  const height = panels[0]?.length ?? 0
  const mid = Math.floor(height / 2)
  const connector = Array.from({ length: height }, (_, i) =>
    i === mid ? '>' : ' '
  )
  const withArrows = panels.flatMap((panel, i) =>
    i === 0 ? [panel] : [connector, panel]
  )
  return joinPanelsHorizontally(
    [...withArrows, compareColumn(params.hash, height)],
    1
  )
}
