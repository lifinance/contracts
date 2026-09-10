/**
 * A recorded codehash is a report. These pin what may be recorded and what may
 * not, in both directions: an accepted group lands complete and canonical, and
 * a rejected one lands nowhere.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IObservedCode } from '../codehash/attested-set'
import type { SelfCheckOutcome } from '../codehash/deploy-self-check'

import {
  codehashFromArgs,
  codehashFromSelfCheck,
  recordedCodehash,
} from './record-codehash'

const HASH = `0x${'1'.repeat(64)}`
const MASKED = `0x${'2'.repeat(64)}`

const observed: IObservedCode = {
  maskedHash: MASKED,
  rawHash: HASH,
  rawByteLength: 7390,
  maskedByteCount: 480,
}

const valid = {
  hash: HASH,
  maskedHash: MASKED,
  byteLength: 7390,
  maskedByteCount: 480,
}

describe('recordedCodehash', () => {
  it('stores the group as given', () => {
    const decision = recordedCodehash(valid)

    expect(decision).toEqual({
      recordable: true,
      codehash: {
        hash: HASH,
        maskedHash: MASKED,
        byteLength: 7390,
        maskedByteCount: 480,
      },
    })
  })

  it('stores a digest in one canonical form whichever the caller used', () => {
    // Comparability later depends on it, and this is storage — not the check.
    const decision = recordedCodehash({
      ...valid,
      hash: HASH.replace('0x', '').toUpperCase(),
    })

    expect(decision).toEqual({
      recordable: true,
      codehash: { ...valid, hash: HASH },
    })
  })

  it.each([
    ['too short', `0x${'1'.repeat(63)}`],
    ['too long', `0x${'1'.repeat(65)}`],
    ['not hex', `0x${'z'.repeat(64)}`],
    ['empty', ''],
    ['a decimal number', '12345'],
  ])('refuses a raw hash that is %s', (_label, hash) => {
    const decision = recordedCodehash({ ...valid, hash })

    expect(decision).toEqual({
      recordable: false,
      reason: expect.stringContaining('is not a keccak digest'),
    })
  })

  it('refuses a masked hash that is not a digest', () => {
    const decision = recordedCodehash({ ...valid, maskedHash: '0xdeadbeef' })

    expect(decision.recordable).toBe(false)
    if (!decision.recordable)
      expect(decision.reason).toContain('not a keccak digest')
  })

  it.each([
    ['zero, which is what an address holding no code reports', 0],
    ['negative', -1],
    ['fractional', 12.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a byte length that is %s', (_label, byteLength) => {
    const decision = recordedCodehash({ ...valid, byteLength })

    expect(decision).toEqual({
      recordable: false,
      reason: expect.stringContaining('describes no code'),
    })
  })

  it('accepts a masked count of zero, which is a real answer', () => {
    // A contract with no immutables. Paired with the refusals above so "0 is
    // rejected" cannot silently become the rule for both counts.
    expect(recordedCodehash({ ...valid, maskedByteCount: 0 })).toEqual({
      recordable: true,
      codehash: { ...valid, maskedByteCount: 0 },
    })
  })

  it('accepts a masked count equal to the whole length', () => {
    expect(
      recordedCodehash({ ...valid, maskedByteCount: valid.byteLength })
    ).toEqual({
      recordable: true,
      codehash: { ...valid, maskedByteCount: valid.byteLength },
    })
  })

  it('refuses more masked bytes than there are bytes', () => {
    const decision = recordedCodehash({
      ...valid,
      maskedByteCount: valid.byteLength + 1,
    })

    expect(decision).toEqual({
      recordable: false,
      reason: expect.stringContaining('cannot have been masked out of'),
    })
  })

  it('refuses a masked count that is not a count', () => {
    const decision = recordedCodehash({ ...valid, maskedByteCount: -3 })

    expect(decision).toEqual({
      recordable: false,
      reason: expect.stringContaining('is not a count of masked bytes'),
    })
  })
})

describe('codehashFromSelfCheck', () => {
  it.each([['PASS'], ['CONFIRM']] as [SelfCheckOutcome][])(
    'records what was observed when the self-check returned %s',
    (outcome) => {
      // Both establish that the deployed code is the artifact this run built;
      // they differ only on the sign-time attestation question.
      expect(codehashFromSelfCheck(observed, outcome)).toEqual({
        recordable: true,
        codehash: {
          hash: HASH,
          maskedHash: MASKED,
          byteLength: 7390,
          maskedByteCount: 480,
        },
      })
    }
  )

  it('records nothing when the self-check refused', () => {
    const decision = codehashFromSelfCheck(observed, 'REFUSE')

    expect(decision).toEqual({
      recordable: false,
      reason: expect.stringContaining('REFUSE'),
    })
  })

  it('records nothing for an outcome outside the permitted set', () => {
    // The set is named by what may proceed, so an outcome added later — or a
    // value that reached here from untyped input — records nothing.
    const decision = codehashFromSelfCheck(
      observed,
      'PASSED' as SelfCheckOutcome
    )

    expect(decision.recordable).toBe(false)
  })

  it('refuses an observation the self-check passed but that describes no code', () => {
    const decision = codehashFromSelfCheck(
      { ...observed, rawByteLength: 0 },
      'PASS'
    )

    expect(decision.recordable).toBe(false)
  })
})

describe('codehashFromArgs', () => {
  const args = {
    codehash: HASH,
    'masked-codehash': MASKED,
    'code-byte-length': '7390',
    'masked-byte-count': '480',
  }

  it('is not requested when no flag was passed', () => {
    expect(
      codehashFromArgs({
        codehash: undefined,
        'masked-codehash': undefined,
        'code-byte-length': undefined,
        'masked-byte-count': undefined,
      })
    ).toEqual({ requested: false })
  })

  it('is not requested when every flag was passed empty', () => {
    expect(
      codehashFromArgs({
        codehash: '',
        'masked-codehash': '',
        'code-byte-length': '',
        'masked-byte-count': '',
      })
    ).toEqual({ requested: false })
  })

  it('records the group when all four are present', () => {
    expect(codehashFromArgs(args)).toEqual({
      requested: true,
      recordable: true,
      codehash: {
        hash: HASH,
        maskedHash: MASKED,
        byteLength: 7390,
        maskedByteCount: 480,
      },
    })
  })

  it.each([
    ['codehash'],
    ['masked-codehash'],
    ['code-byte-length'],
    ['masked-byte-count'],
  ] as [
    'codehash' | 'masked-codehash' | 'code-byte-length' | 'masked-byte-count'
  ][])('records nothing when only %s is missing', (missing) => {
    const decision = codehashFromArgs({ ...args, [missing]: undefined })

    expect(decision).toEqual({
      requested: true,
      recordable: false,
      // The flag an operator would have to add, not the field name behind it.
      reason: expect.stringContaining(`--${missing}`),
    })
  })

  it.each([
    ['a trailing unit', '7390 bytes'],
    ['leading text', 'about 7390'],
    ['hex', '0x1cde'],
    ['a decimal point', '7390.0'],
    ['a sign', '+7390'],
    ['whitespace', ' 7390 '],
  ])('records nothing for a byte length with %s', (_label, byteLength) => {
    // `parseInt('7390 bytes')` answers 7390, and `parseInt('0x1cde')` answers
    // exactly 7390 too. A length that has to be repaired to be read is not a
    // length that was observed.
    const decision = codehashFromArgs({
      ...args,
      'code-byte-length': byteLength,
    })

    expect(decision).toEqual({
      requested: true,
      recordable: false,
      reason: expect.stringContaining('whole numbers'),
    })
  })

  it('records nothing for a masked count that is not a whole number', () => {
    const decision = codehashFromArgs({ ...args, 'masked-byte-count': '-1' })

    expect(decision).toEqual({
      requested: true,
      recordable: false,
      reason: expect.stringContaining('whole numbers'),
    })
  })

  it('carries the group validation through, tagged as requested', () => {
    const decision = codehashFromArgs({ ...args, codehash: '0xnothex' })

    expect(decision).toEqual({
      requested: true,
      recordable: false,
      reason: expect.stringContaining('is not a keccak digest'),
    })
  })
})
