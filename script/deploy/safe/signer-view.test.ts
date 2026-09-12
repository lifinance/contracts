// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import {
  bucketOf,
  checkSummary,
  PROPOSAL_SEPARATOR,
  renderCheckGroups,
  renderFields,
  renderTodos,
  VIEW_WIDTH,
  zoneHeading,
  type IBucketedResult,
} from './signer-view'

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const definition = (checkId: string, title: string): ICheckDefinition => ({
  checkId,
  section: 'section',
  checkClass: 'integrity',
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
  it('separates a proposal that is wrong from a check that could not run', () => {
    expect(bucketOf('fail')).toBe('wrong')
    expect(bucketOf('error')).toBe('unchecked')
  })

  it('reads an unrecognised status as unchecked, never as passed', () => {
    expect(bucketOf('constructor')).toBe('unchecked')
    expect(bucketOf('toString')).toBe('unchecked')
    expect(bucketOf('')).toBe('unchecked')
  })

  // Applicability is a property of the proposal, not of the result, so it has
  // to override every status — including a `pass` recorded by a check that had
  // nothing to look at.
  it('puts a check with nothing to do under not-applicable, whatever its status', () => {
    expect(bucketOf('pass', true)).toBe('n/a')
    expect(bucketOf('fail', true)).toBe('n/a')
    expect(bucketOf('error', true)).toBe('n/a')
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
    const glyphs = ['⛔', '?', '✓', '·']

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
  it('surrounds a full-width labelled rule with blank lines', () => {
    const lines = PROPOSAL_SEPARATOR.map(stripAnsi)

    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('')
    expect(lines[2]).toHaveLength(VIEW_WIDTH)
    expect(lines[2]).toContain('end of proposal')
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe('')
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

  it('keeps a word longer than the budget whole', () => {
    const lines = renderCheckGroups([
      {
        definition: definition('x', 'A check'),
        result: result('x', 'fail', { actual: `0x${'a'.repeat(200)}` }),
      },
    ]).map(stripAnsi)

    expect(lines.join('\n')).toContain(`0x${'a'.repeat(200)}`)
  })
})
