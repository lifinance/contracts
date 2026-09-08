import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  buildSafeTxDetailLines,
  type ISafeTxDetailInput,
} from './safe-tx-detail-display'

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
  nonce: '31',
  nonceColor: '32',
  nonceWarning: '',
  toDisplay: '0x11f1022cA6AdEF6400e5677528a80d49a069C00c',
  toExplorerSuffix: '',
  value: '0',
  operationLabel: 'Call',
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
  const cases: {
    field: keyof ISafeTxDetailInput
    label: string
  }[] = [
    { field: 'data', label: 'Data:' },
    { field: 'safeTxHash', label: 'Safe Tx Hash:' },
    { field: 'proposer', label: 'Proposer:' },
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

    expect(zeroWidth).toContain('stored 5, shown 4')
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
        '1 invisible character in a value of 5'
      )

    expect(
      lineStartingWith(linesFor({ data: '0x1\u200d\u31642' }), 'Data:')
    ).toContain('2 invisible characters in a value of 6')
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
    expect(line).toContain('stored 3, shown 2')
  })

  it('says so when a field renders to nothing at all', () => {
    const line = lineStartingWith(
      linesFor({ proposer: '\u001b\u0007\u009b' }),
      'Proposer:'
    )

    expect(line).toContain('no printable characters')
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

  it('keeps the nonce warning, explorer suffix and ready mark verbatim', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      nonceColor: '31',
      nonceWarning: ' \u001b[31m✗ STALE\u001b[0m',
      toExplorerSuffix: ' \u001b[36mhttps://etherscan.io/address/0x11\u001b[0m',
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

  it('renders a parked ref that is not an object', () => {
    const lines = buildSafeTxDetailLines({
      ...benign,
      parkedTaskRefs: [undefined as never, 'not an object' as never],
    })

    expectNoTerminalControl(lines)
  })
})
