// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import {
  bucketOf,
  checkSummary,
  PROPOSAL_SEPARATOR,
  renderCheckGroups,
  renderFields,
  renderGateManifest,
  renderTodos,
  VIEW_WIDTH,
  zoneHeading,
  type IBucketedResult,
} from './signer-view'

const ESC = String.fromCharCode(27)
const RESET_CODE = `${String.fromCharCode(27)}[0m`

const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
const RED = `${ESC}[31m`
const YELLOW = `${ESC}[33m`

/**
 * Where a check's values start: the eight-space block indent, the widest label
 * the rows carry, and the two-space gap after it. Written out rather than
 * imported, so a renderer that stops deriving the column from its labels fails
 * here instead of moving the number it is checked against.
 */
const VALUE_COLUMN = 8 + 'expected'.length + 2

const definition = (
  checkId: string,
  title: string,
  checkClass: ICheckDefinition['checkClass'] = 'integrity'
): ICheckDefinition => ({
  checkId,
  section: 'section',
  checkClass,
  gate: 'X',
  title,
})

const result = (
  checkId: string,
  status: string,
  overrides: Partial<ICheckResult> = {}
): ICheckResult =>
  ({
    checkId,
    network: 'arbitrum',
    status,
    expected: 'expected value',
    actual: 'observed value',
    anchor: 'A-LOCAL',
    ...overrides,
  } as ICheckResult)

const entry = (
  checkId: string,
  status: string,
  overrides: Partial<IBucketedResult> = {}
): IBucketedResult => ({
  definition: definition(checkId, `title for ${checkId}`),
  result: result(checkId, status),
  ...overrides,
})

describe('bucketOf', () => {
  const at = (
    status: string,
    checkClass: ICheckDefinition['checkClass'] = 'integrity',
    notApplicable?: string
  ): IBucketedResult => ({
    definition: definition('some-check', 'title', checkClass),
    result: result('some-check', status),
    ...(notApplicable ? { notApplicable } : {}),
  })

  it('separates a proposal that is wrong from a check that could not run', () => {
    expect(bucketOf(at('fail'))).toBe('wrong')
    expect(bucketOf(at('error'))).toBe('unchecked')
  })

  it('reads an unrecognised status as unchecked, never as passed', () => {
    expect(bucketOf(at('constructor'))).toBe('unchecked')
    expect(bucketOf(at('toString'))).toBe('unchecked')
    expect(bucketOf(at(''))).toBe('unchecked')
  })

  // Applicability is a property of the proposal, not of the result, so it has
  // to override every status — including a `pass` recorded by a check that had
  // nothing to look at.
  it('puts a check with nothing to do under not-applicable, whatever its status', () => {
    expect(bucketOf(at('pass', 'integrity', 'nothing here'))).toBe('n/a')
    expect(bucketOf(at('fail', 'integrity', 'nothing here'))).toBe('n/a')
    expect(bucketOf(at('error', 'integrity', 'nothing here'))).toBe('n/a')
  })

  // The heading has to name what the run will do. `summariseLedger` sorts a
  // semantic mismatch into `requiresAcknowledgement` and offers Sign, so
  // printing it under "the proposal is wrong — do not sign" told the signer the
  // opposite of what happened next. Observed on seven of eleven rehearsal
  // proposals, all of them gate I.
  it('puts an acknowledgeable mismatch under ack, not under wrong', () => {
    expect(bucketOf(at('fail', 'semantic'))).toBe('ack')
    expect(bucketOf(at('needs-ack', 'semantic'))).toBe('ack')
  })

  // The other direction, which fails dangerously: an integrity check has no
  // acknowledgement path at all, so a row that asked to be acknowledged would
  // be inviting a signature the run will not take.
  it('keeps an integrity mismatch under wrong, however it is graded', () => {
    expect(bucketOf(at('fail', 'integrity'))).toBe('wrong')
    expect(bucketOf(at('needs-ack', 'integrity'))).toBe('wrong')
  })
})

describe('renderCheckGroups', () => {
  const mixed: IBucketedResult[] = [
    entry('INT-SAFE-ADDRESS', 'fail'),
    entry('rpc-quorum', 'error'),
    entry('INT-TARGET', 'pass'),
    entry('codehash', 'pass', { notApplicable: 'no diamondCut here' }),
  ]

  it('gives every bucket its own glyph, so none is told apart by wording alone', () => {
    const plain = renderCheckGroups(mixed).map(stripAnsi).join('\n')
    const glyphs = ['⛔', '?', '✅', '·']

    for (const glyph of glyphs) expect(plain).toContain(glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  // The defect this view was built for: a tampered Safe address and an
  // unreachable RPC printed the same red stop sign, so the signer could not
  // tell "the transaction is dangerous" from "my laptop could not check".
  it('does not print the wrong-bucket glyph for a check that merely could not run', () => {
    const onlyUnchecked = renderCheckGroups([entry('rpc-quorum', 'error')])
      .map(stripAnsi)
      .join('\n')

    expect(onlyUnchecked).toContain('?')
    expect(onlyUnchecked).not.toContain('⛔')
    expect(onlyUnchecked.toLowerCase()).toContain('your environment')
  })

  it('orders the buckets so what stops you is read first', () => {
    const plain = renderCheckGroups(mixed).map(stripAnsi).join('\n')
    const at = (needle: string): number => plain.indexOf(needle)

    expect(at('THE PROPOSAL IS WRONG')).toBeLessThan(at('COULD NOT BE CHECKED'))
    expect(at('COULD NOT BE CHECKED')).toBeLessThan(at('PASSED'))
    expect(at('PASSED')).toBeLessThan(at('NOT APPLICABLE'))
  })

  it('gives every passed gate its own line', () => {
    const passed = [
      entry('INT-SAFE-TX-HASH', 'pass'),
      entry('INT-FIXED-FIELDS', 'pass'),
      entry('INT-TARGET', 'pass'),
      entry('target-state', 'pass'),
    ]
    const lines = renderCheckGroups(passed)
      .map(stripAnsi)
      .filter((line) => line.trimStart().startsWith('✅'))

    expect(lines).toHaveLength(passed.length)
    for (const line of lines) expect(line).toContain('title for')
  })

  it('points a passed gate at its write-up too', () => {
    const plain = renderCheckGroups([
      entry('INT-TARGET', 'pass', { docUrl: 'https://example.invalid/gate-e' }),
    ])
      .map(stripAnsi)
      .join('\n')

    expect(plain).toContain('https://example.invalid/gate-e')
  })

  it('keeps the full title for a check with no short label', () => {
    const plain = renderCheckGroups([entry('codehash', 'pass')])
      .map(stripAnsi)
      .join('\n')

    expect(plain).toContain('title for codehash')
  })

  it('omits a bucket nothing landed in', () => {
    const plain = renderCheckGroups([entry('INT-TARGET', 'pass')])
      .map(stripAnsi)
      .join('\n')

    expect(plain).toContain('PASSED')
    expect(plain).not.toContain('THE PROPOSAL IS WRONG')
    expect(plain).not.toContain('NOT APPLICABLE')
  })

  it('states why a not-applicable check had nothing to do', () => {
    const plain = renderCheckGroups([
      entry('codehash', 'pass', { notApplicable: 'no diamondCut here' }),
    ])
      .map(stripAnsi)
      .join('\n')

    expect(plain).toContain('no diamondCut here')
    // It had nothing to observe, so printing an expected/observed pair would
    // invite the signer to compare two blanks.
    expect(plain).not.toContain('expected')
    expect(plain).not.toContain('observed')
  })

  it('keeps a collapsed pass run inside the view width', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry(`CHECK-${i}`, 'pass')
    )
    const lines = renderCheckGroups(many).map(stripAnsi)

    for (const line of lines)
      expect(line.length).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('shows each failing check its expected and observed values', () => {
    const plain = renderCheckGroups([entry('INT-SAFE-ADDRESS', 'fail')])
      .map(stripAnsi)
      .join('\n')

    expect(plain).toContain('expected  expected value')
    expect(plain).toContain('observed  observed value')
  })
})

describe('checkSummary', () => {
  it('counts wrong and unchecked separately', () => {
    const summary = checkSummary([
      entry('a', 'fail'),
      entry('b', 'error'),
      entry('c', 'error'),
      entry('d', 'pass'),
    ])

    expect(summary).toBe('1 wrong · 2 unchecked · 1 passed')
  })

  it('names no bucket that is empty', () => {
    expect(checkSummary([entry('a', 'pass')])).toBe('1 passed')
  })
})

describe('zoneHeading', () => {
  it('separates a zone from whatever preceded it', () => {
    const [first, second] = zoneHeading(2, 'WHAT WAS CHECKED FOR YOU')

    expect(first).toBe('')
    expect(second).toBe('')
  })

  it('draws the heading to the view width', () => {
    for (const line of zoneHeading(1, 'A TITLE', 'right side'))
      expect(stripAnsi(line).length).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('keeps a long title and summary on one line rather than overlapping', () => {
    const long = zoneHeading(2, 'W'.repeat(50), 'R'.repeat(40)).map(stripAnsi)
    const heading = long[3] ?? ''

    expect(heading).toContain('W'.repeat(50))
    expect(heading).toContain('R'.repeat(40))
  })
})

describe('renderFields', () => {
  it('aligns values on the longest label', () => {
    const lines = renderFields([
      { label: 'Safe', value: '0xaaa' },
      { label: 'Operation', value: 'Call' },
    ]).map(stripAnsi)

    const valueColumn = (line: string, value: string): number =>
      line.indexOf(value)

    expect(valueColumn(lines[0] ?? '', '0xaaa')).toBe(
      valueColumn(lines[1] ?? '', 'Call')
    )
  })

  it('prints a note under the value it belongs to', () => {
    const lines = renderFields([
      { label: 'Action', value: 'registerPeripheryContract', note: 'a note' },
    ]).map(stripAnsi)

    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('a note')
  })
})

describe('renderTodos', () => {
  it('renders each step as an unticked box', () => {
    const plain = renderTodos([
      { text: 'Compare the hash', lines: ['6d54855a … 25b64830'] },
      { text: 'Then sign on the device' },
    ])
      .map(stripAnsi)
      .join('\n')

    expect(plain.match(/☐/g)).toHaveLength(2)
    expect(plain).toContain('6d54855a … 25b64830')
  })
})

describe('PROPOSAL_SEPARATOR', () => {
  it('banners the end of a proposal between two full-width rules', () => {
    const lines = PROPOSAL_SEPARATOR.map(stripAnsi)

    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('x'.repeat(VIEW_WIDTH))
    expect(lines[3]).toContain('END OF PROPOSAL')
    expect(lines[3]).toContain('<<<')
    expect(lines[3]).toContain('>>>')
    expect(lines[4]).toBe('x'.repeat(VIEW_WIDTH))
    expect(lines[5]).toBe('')
    expect(lines[6]).toBe('')
  })
})

describe('a check value too wide for the view', () => {
  it('wraps under a hanging indent instead of running off the terminal', () => {
    const lines = renderCheckGroups([
      {
        definition: definition('executability', 'Calldata simulation'),
        result: result('executability', 'fail', {
          actual:
            'eth_call reverted\n\nRaw Call Arguments:\n  to:   0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE\n\nDetails: execution reverted',
        }),
      },
    ]).map(stripAnsi)

    for (const line of lines)
      expect(line.length).toBeLessThanOrEqual(VIEW_WIDTH)
    // Folded: the blob's own blank lines do not survive into the block.
    expect(lines.filter((line) => line.trim() === '')).toHaveLength(1)
    expect(lines.join(' ').replace(/\s+/gu, ' ')).toContain(
      'Details: execution reverted'
    )
  })

  it('keeps a hash whole, however badly it fits the column', () => {
    const hash = `0x${'a'.repeat(64)}`
    const lines = renderCheckGroups([
      {
        definition: definition('x', 'A check'),
        result: result('x', 'fail', { actual: `reverted at ${hash}` }),
      },
    ]).map(stripAnsi)

    expect(lines.join('\n')).toContain(hash)
  })

  // A revert dump carries the payload viem was called with, and zone 1 already
  // prints that payload in full: printed again here it buries the revert reason
  // under several screens of hex.
  it('elides a payload too long to read, and says how long it was', () => {
    const payload = `0x${'ab'.repeat(600)}`
    const lines = renderCheckGroups([
      {
        definition: definition('x', 'A check'),
        result: result('x', 'fail', {
          actual: `eth_call reverted, data: ${payload} Details: execution reverted`,
        }),
      },
    ]).map(stripAnsi)
    const joined = lines.join('\n')

    for (const line of lines)
      expect(line.length).toBeLessThanOrEqual(VIEW_WIDTH)
    expect(joined).not.toContain(payload)
    expect(joined).toContain(payload.slice(0, 20))
    expect(joined).toContain(`${payload.length} chars`)
    expect(joined.replace(/\s+/gu, ' ')).toContain(
      'Details: execution reverted'
    )
  })
})

describe('a value that disagrees with its expectation', () => {
  const lineWith = (entry: IBucketedResult, label: string): string =>
    renderCheckGroups([entry]).find((line) =>
      stripAnsi(line).includes(label)
    ) ?? ''

  it('paints the observed value red, and leaves the expectation plain', () => {
    const wrong = entry('INT-TIMELOCK-DELAY', 'fail')

    expect(lineWith(wrong, 'observed')).toContain(`${RED}observed value`)
    expect(lineWith(wrong, 'expected')).toBe(
      stripAnsi(lineWith(wrong, 'expected'))
    )
  })

  it('marks an acknowledgeable mismatch in its own colour, never in red', () => {
    // Semantic deliberately: an acknowledgeable mismatch is one the run will
    // let a signer acknowledge, and only a semantic check can be one.
    const line = lineWith(
      entry('target-state', 'needs-ack', {
        definition: definition('target-state', 'title', 'semantic'),
      }),
      'observed'
    )

    expect(line).toContain(`${YELLOW}observed value`)
    expect(line).not.toContain(RED)
  })

  // `actual` on an unchecked row is why nothing could be read, not something
  // read: colouring it as a mismatch blames the proposal for the environment.
  it('leaves an unchecked row uncoloured, where a wrong one is coloured', () => {
    const unchecked = lineWith(entry('rpc-quorum', 'error'), 'observed')
    const wrong = lineWith(entry('rpc-quorum', 'fail'), 'observed')

    expect(unchecked).toBe(stripAnsi(unchecked))
    expect(wrong).not.toBe(stripAnsi(wrong))
  })

  it('marks nothing when the two values read the same', () => {
    const same = lineWith(
      {
        definition: definition('x', 'A check'),
        result: result('x', 'fail', {
          expected: 'one value',
          actual: 'one\nvalue',
        }),
      },
      'observed'
    )

    expect(stripAnsi(same)).toContain('observed  one value')
    expect(same).toBe(stripAnsi(same))
  })
})

describe('the column a check prints its values in', () => {
  const columnOf = (line: string, value: string): number =>
    stripAnsi(line).indexOf(value)

  it('is one column for every label, whatever the labels are', () => {
    const lines = renderCheckGroups([entry('INT-SAFE-ADDRESS', 'fail')]).filter(
      (line) => /expected|observed/u.test(stripAnsi(line))
    )
    const [expectedColumn, observedColumn] = [
      columnOf(lines[0] ?? '', 'expected value'),
      columnOf(lines[1] ?? '', 'observed value'),
    ]

    expect(lines).toHaveLength(2)
    expect(expectedColumn).toBe(observedColumn)
    expect(expectedColumn).toBe(VALUE_COLUMN)
  })

  it('keeps a wrapped value in the same column as the line it continues', () => {
    const lines = renderCheckGroups([
      {
        definition: definition('executability', 'Calldata simulation'),
        result: result('executability', 'fail', {
          actual: `${'word '.repeat(30)}tail`,
        }),
      },
    ]).map(stripAnsi)
    const continuation = lines.find((line) => line.trimEnd().endsWith('tail'))

    expect(continuation).toBeDefined()
    expect((continuation ?? '').search(/\S/u)).toBe(VALUE_COLUMN)
  })
})

describe('the head of a check row', () => {
  it('carries the gate name and neither the check id nor the anchor code', () => {
    const rendered = renderCheckGroups([
      {
        definition: definition(
          'INT-SAFE-TX-HASH',
          'Gate B \u00b7 Safe tx hash'
        ),
        result: result('INT-SAFE-TX-HASH', 'fail', { anchor: 'A-CHAIN' }),
      },
    ])
      .map(stripAnsi)
      .join('\n')

    expect(rendered).toContain('Gate B \u00b7 Safe tx hash')
    expect(rendered).toContain('expected')
    expect(rendered).not.toContain('INT-SAFE-TX-HASH')
    expect(rendered).not.toContain('A-CHAIN')
  })
})

describe('a check with a write-up to point at', () => {
  it('prints the link beside the gate name, and nothing when there is none', () => {
    const [withLink, withoutLink] = [
      { docUrl: 'https://example.invalid/checks/x' },
      {},
    ].map((extra) =>
      renderCheckGroups([
        {
          definition: definition('x', 'A check'),
          result: result('x', 'fail'),
          ...extra,
        },
      ])
        .map(stripAnsi)
        .join('\n')
    )

    expect(withLink).toContain('A check https://example.invalid/checks/x')
    expect(withoutLink).toContain('A check')
    expect(withoutLink).not.toContain('https://')
  })
})

describe('check notes', () => {
  it('keeps a passed check’s note under its own line', () => {
    const plain = renderCheckGroups([
      entry('target-state', 'pass', {
        notes: ['    Expected state:  read from origin/main'],
      }),
    ])
      .map(stripAnsi)
      .join('\n')

    expect(plain).toContain('title for target-state')
    expect(plain).toContain('Expected state:  read from origin/main')
  })

  it('prints a note under the check it belongs to', () => {
    const plain = renderCheckGroups([
      entry('target-state', 'fail', { notes: ['    read from origin/main'] }),
    ])
      .map(stripAnsi)
      .join('\n')
    const lines = plain.split('\n')

    expect(lines.indexOf('    read from origin/main')).toBeGreaterThan(
      lines.findIndex((l) => l.includes('title for target-state'))
    )
  })
})

describe('a reason a check had nothing to do', () => {
  it('wraps inside the view rather than running past the terminal', () => {
    const lines = renderCheckGroups([
      entry('codehash', 'pass', {
        notApplicable:
          'not run by this harness, which has no deployment record to read',
      }),
    ]).map(stripAnsi)

    for (const line of lines)
      expect(line.length).toBeLessThanOrEqual(VIEW_WIDTH)
    expect(lines.join(' ').replace(/\s+/gu, ' ')).toContain(
      'no deployment record to read'
    )
  })
})

describe('a pair of values compared character by character', () => {
  const HASH =
    '0x8c7e2e6b9edf4f60207d48d7eba1bf5f29667ada41df1c0e6bda53217f334b92'

  const rendered = (expected: string, actual: string): string[] =>
    renderCheckGroups([
      entry('safe-tx-hash', 'fail', {
        result: result('safe-tx-hash', 'fail', { expected, actual }),
      }),
    ]).flatMap((line) => stripAnsi(line).split('\n'))

  it('marks the one character that differs, under the column it is in', () => {
    const lines = rendered(HASH, `${HASH.slice(0, -1)}0`)
    const carets = lines.find((line) => line.trim().startsWith('^'))

    expect(carets).toBeDefined()
    // The caret sits under the last character, which is the one that changed —
    // asserted as a column, because a caret row that is merely present would
    // pass while pointing at the wrong character.
    const observed = lines.find((line) =>
      line.includes(`${HASH.slice(0, -1)}0`)
    )
    expect(observed).toBeDefined()
    expect((carets as string).indexOf('^')).toBe(
      (observed as string).length - 1
    )
  })

  it('marks every differing character, not only the first', () => {
    const tampered = `0x0${HASH.slice(3, -1)}0`
    const carets = rendered(HASH, tampered).find((line) =>
      line.trim().startsWith('^')
    )

    expect((carets ?? '').split('^').length - 1).toBe(2)
  })

  it('keeps the pair inside the view, where the labelled form did not', () => {
    // A bytes32 is 66 characters; under an eight-column indent and a ten-column
    // label it was 84. Pulled back to the margin it is 74.
    for (const line of rendered(HASH, `${HASH.slice(0, -1)}0`))
      expect(line.length).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('prints the values adjacent, because comparing them is the task', () => {
    const lines = rendered(HASH, `${HASH.slice(0, -1)}0`)
    const first = lines.findIndex((line) => line.includes(HASH))
    const second = lines.findIndex((line) =>
      line.includes(`${HASH.slice(0, -1)}0`)
    )

    expect(first).toBeGreaterThan(-1)
    expect(second).toBe(first + 1)
  })

  // The negative half. A caret row under values of different lengths points at
  // a column that means nothing, and prose reads better under its label.
  it('does not use the pair form for values of different lengths', () => {
    const lines = rendered(HASH, HASH.slice(0, -4))

    expect(lines.some((line) => line.trim().startsWith('^'))).toBe(false)
    expect(lines.some((line) => line.includes('expected'))).toBe(true)
  })

  it('does not use the pair form for prose', () => {
    const lines = rendered('every signature recovers', 'nothing recovered here')

    expect(lines.some((line) => line.trim().startsWith('^'))).toBe(false)
  })
})

/**
 * Terminal columns a string occupies.
 *
 * `String.length` counts UTF-16 units, which is not what a signer sees: `⛔` is
 * one unit and two columns, and `⚠️` is two units and two columns. A width
 * assertion written against `.length` passes on a row that runs a column past
 * the view.
 *
 * Spelled out here rather than imported from the view: a width check that
 * measures with the same table the view pads with agrees with it by
 * construction, including when both are wrong.
 */
const WIDE_GLYPHS: ReadonlySet<string> = new Set(['⛔', '✅', '⚠'])
const displayWidth = (text: string): number =>
  [...text].reduce(
    (n, ch) => (ch === '\uFE0F' ? n : n + (WIDE_GLYPHS.has(ch) ? 2 : 1)),
    0
  )

describe('renderGateManifest', () => {
  const gate = (
    letter: string,
    checkId: string,
    title: string,
    checkClass: ICheckDefinition['checkClass'] = 'integrity'
  ): ICheckDefinition => ({
    checkId,
    section: 'section',
    checkClass,
    gate: letter,
    title,
  })

  const ROSTER: ICheckDefinition[] = [
    gate('A', 'a-check', 'Safe address'),
    gate('B', 'b-check', 'Owner signatures'),
    gate('C', 'c-check', 'Storage authorities'),
    gate('D', 'd-check', 'Calldata simulation', 'semantic'),
    gate('K', 'k-check', 'Deployed bytecode'),
  ]
  // Every gate but K owes a result: K has a letter and no ledger denominator,
  // the same way the codehash gate does in the registry.
  const OWED = new Set(['a-check', 'b-check', 'c-check', 'd-check'])

  const render = (entries: IBucketedResult[]): string[] =>
    renderGateManifest({ entries, roster: ROSTER, mustReport: OWED }).map(
      stripAnsi
    )

  const rowFor = (lines: string[], letter: string): string => {
    const found = lines.find((line) =>
      new RegExp(`^\\s+\\S+\\s*${letter}\\s`, 'u').test(line)
    )
    if (!found)
      throw new Error(`no manifest row for gate ${letter}: ${lines.join('|')}`)
    return found
  }

  it('prints one row per gate on the roster, results or not', () => {
    const lines = render([entry('a-check', 'pass')])
    for (const definition of ROSTER)
      expect(rowFor(lines, definition.gate)).toContain(definition.title)
  })

  it('reads a gate that owed a result and gave none as NO RESULT, never as a pass', () => {
    const lines = render([entry('a-check', 'pass')])
    const row = rowFor(lines, 'C')
    expect(row).toContain('NO RESULT')
    expect(row).toContain('BLOCKS')
    // The present half of the pair: the gate that *did* pass says so, so a
    // renderer that printed "ok" everywhere would fail the line above rather
    // than satisfy both.
    expect(rowFor(lines, 'A')).toContain('ok')
    expect(row).not.toContain('ok')
  })

  it('does not call a gate silent when it never owed a result', () => {
    // Every gate that owes a result gives one, so K is the only row without
    // one. "silent" appearing at all would mean K had been counted.
    const lines = render([
      entry('a-check', 'pass'),
      entry('b-check', 'pass'),
      entry('c-check', 'pass'),
      entry('d-check', 'pass'),
    ])
    const row = rowFor(lines, 'K')
    expect(row).not.toContain('NO RESULT')
    expect(row).not.toContain('BLOCKS')
    expect(lines.at(-1)).not.toContain('silent')
    // And the present half: a gate that does owe one and withholds it is
    // counted, so the assertion above is not simply unreachable.
    expect(render([entry('a-check', 'pass')]).at(-1)).toContain('3 silent')
  })

  it('counts the roster, what owes a result, and what reported', () => {
    const tally = render([
      entry('a-check', 'pass'),
      entry('b-check', 'pass'),
      entry('c-check', 'pass'),
      entry('d-check', 'pass'),
    ]).at(-1)
    expect(tally).toContain('5 gates')
    expect(tally).toContain('4 owe a result')
    expect(tally).toContain('4 reported')
    expect(tally).not.toContain('silent')
  })

  it('separates a mismatch that blocks from one the run will let you acknowledge', () => {
    const lines = render([
      entry('b-check', 'fail'),
      entry('d-check', 'fail', {
        definition: gate('D', 'd-check', 'Calldata simulation', 'semantic'),
      }),
    ])
    // Same status, opposite disposition: the integrity gate has no
    // acknowledgement path and the semantic one does. This is the distinction
    // the sections were getting wrong before `isAcknowledgeable`.
    expect(rowFor(lines, 'B')).toContain('WRONG')
    expect(rowFor(lines, 'B')).toContain('BLOCKS')
    expect(rowFor(lines, 'D')).toContain('WRONG')
    expect(rowFor(lines, 'D')).toContain('yours')
    expect(rowFor(lines, 'D')).not.toContain('BLOCKS')
  })

  it('surfaces a result that names no gate on the roster', () => {
    const lines = render([entry('a-check', 'pass'), entry('stranger', 'fail')])
    const orphan = lines.find((line) => line.includes('stranger'))
    expect(orphan).toBeDefined()
    expect(orphan).toContain('no gate on the roster')
  })

  it('ends no row in whitespace', () => {
    // The verdict column is padded to a fixed width, and the padding used to
    // sit inside the colour codes — so a row with no disposition ended in a
    // reset rather than a space and `trimEnd` could not reach it. Every run
    // piped to a file or pasted into Slack carried it.
    const lines = render([
      entry('a-check', 'pass'),
      entry('b-check', 'fail'),
      entry('d-check', 'needs-ack'),
    ])
    for (const line of lines) expect(line).toBe(line.trimEnd())
  })

  it('keeps every row inside the view width', () => {
    const lines = render([
      entry('a-check', 'pass'),
      entry('b-check', 'fail'),
      entry('d-check', 'needs-ack'),
    ])
    for (const line of lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('starts every gate letter in the same column, wide glyph or not', () => {
    // The blocking row carries the two-column stop sign and the passing row a
    // one-column tick. `indexOf` would compare UTF-16 offsets, which is not the
    // unit the reader sees: `⛔` is one code unit and two terminal columns, so
    // the two rows differ by one there and line up on screen.
    const lines = render([entry('a-check', 'pass'), entry('b-check', 'fail')])
    const columnOf = (letter: string): number => {
      const row = rowFor(lines, letter)
      return displayWidth(row.slice(0, row.indexOf(letter)))
    }
    expect(columnOf('A')).toBe(columnOf('B'))
  })
})

describe('a pre-formatted note, folded into the view', () => {
  const RED_CODE = `${String.fromCharCode(27)}[31m`
  const SGR_ALL = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'gu')

  /** True when a line ends with no SGR still open. */
  const closesCleanly = (line: string): boolean => {
    let open = 0
    SGR_ALL.lastIndex = 0
    let match = SGR_ALL.exec(line)
    while (match) {
      if (match[1] === '0' || match[1] === '') open = 0
      else open += 1
      match = SGR_ALL.exec(line)
    }
    return open === 0
  }

  const LONG =
    'cuts[0].selectors[0] — replaces 0xa1f1ce43 with 0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd, which already serves it on chain, so the cut is a no-op LibDiamond rejects'

  const withNote = (note: string): string[] =>
    renderCheckGroups([
      entry('executability', 'fail', {
        definition: definition(
          'executability',
          'Calldata simulation',
          'semantic'
        ),
        notes: [note],
      }),
    ]).flatMap((line) => line.split('\n'))

  it('folds a note that would otherwise run off the view', () => {
    // The executability panel builds these pre-indented and hands them over. A
    // single one of them measured 188 columns against a 76-column view.
    for (const line of withNote(`        ${LONG}`))
      expect(stripAnsi(line).length).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('leaves a note that already fits exactly as it was', () => {
    const short = '        Simulation: FAILED'

    expect(withNote(short)).toContain(short)
  })

  it('keeps each folded line closing its own colour', () => {
    // A span carried across a break bleeds into the next line's indent; one
    // dropped at a break loses the colour. Neither is visible in a width check.
    for (const line of withNote(`        ${RED_CODE}${LONG}${RESET_CODE}`))
      expect(closesCleanly(line)).toBe(true)
  })

  it('measures width without the escapes, which cost no columns', () => {
    // One span across the whole line, not a colour per word: a per-word
    // painted line is a fixed point of the folder — it re-emits exactly what
    // it read — so folding it is identity and the assertion observes nothing.
    // A single span folds into per-word spans, which is the difference this
    // test needs in order to fail when escapes are counted as columns.
    const words =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu ' +
      'xi omicron pi rho sigma tau upsilon phi chi psi omega digamma'
    const painted = `        ${RED_CODE}${words}${RESET_CODE}`

    // The preconditions, asserted rather than assumed: the line fits the view
    // by visible width and does not fit it by byte length.
    expect(stripAnsi(painted).length).toBeLessThanOrEqual(VIEW_WIDTH)
    expect(painted.length).toBeGreaterThan(VIEW_WIDTH)

    expect(withNote(painted)).toContain(painted)
  })

  it('hangs continuations past the note own indent, so it reads as one item', () => {
    // Matched on fragments of the note itself rather than one phrase: where
    // the fold lands is an implementation detail, and a filter pinned to a
    // phrase that happens to straddle a break silently matches nothing.
    const noteLines = withNote(`        ${LONG}`).filter((line) =>
      /cuts\[0\]|0xAd3f|LibDiamond/u.test(stripAnsi(line))
    )

    expect(noteLines.length).toBeGreaterThan(1)
    expect(stripAnsi(noteLines[0] as string).match(/^ */u)?.[0]).toHaveLength(8)
    for (const line of noteLines.slice(1))
      expect(stripAnsi(line).match(/^ */u)?.[0]).toHaveLength(10)
  })
})
