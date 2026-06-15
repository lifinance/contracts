import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normalizeTronProposeCalls } from './propose-calls-tron'

// Base58 Tron addresses are validated downstream during base58→EVM conversion,
// so the normalizer only pairs/validates calldata. Placeholder base58 strings.
const TARGET_A = 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const TARGET_B = 'TBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const CALLDATA_REMOVE = '0xdeadbeef'
const CALLDATA_ADD = '0xcafebabe'

describe('normalizeTronProposeCalls', () => {
  it('normalizes a single to/calldata pair', () => {
    const { targets, calldatas } = normalizeTronProposeCalls(
      TARGET_A,
      CALLDATA_REMOVE,
      false
    )
    expect(targets).toEqual([TARGET_A])
    expect(calldatas).toEqual([CALLDATA_REMOVE])
  })

  it('normalizes multiple pairs with timelock, preserving order', () => {
    const { targets, calldatas } = normalizeTronProposeCalls(
      [TARGET_A, TARGET_B],
      [CALLDATA_REMOVE, CALLDATA_ADD],
      true
    )
    expect(targets).toEqual([TARGET_A, TARGET_B])
    expect(calldatas).toEqual([CALLDATA_REMOVE, CALLDATA_ADD])
  })

  it('rejects multiple pairs without --timelock', () => {
    expect(() =>
      normalizeTronProposeCalls(
        [TARGET_A, TARGET_B],
        [CALLDATA_REMOVE, CALLDATA_ADD],
        false
      )
    ).toThrow(/require --timelock/)
  })

  it('rejects mismatched to/calldata counts', () => {
    expect(() =>
      normalizeTronProposeCalls([TARGET_A, TARGET_B], [CALLDATA_REMOVE], true)
    ).toThrow(/must match/)
  })

  it('rejects missing to (undefined)', () => {
    expect(() =>
      normalizeTronProposeCalls(undefined, CALLDATA_REMOVE, false)
    ).toThrow(/--to/)
  })

  it('rejects an empty to array', () => {
    expect(() =>
      normalizeTronProposeCalls([], [CALLDATA_REMOVE], false)
    ).toThrow(/--to/)
  })

  it('rejects an empty to string', () => {
    expect(() => normalizeTronProposeCalls('', CALLDATA_REMOVE, false)).toThrow(
      /--to/
    )
  })

  it('rejects missing calldata', () => {
    expect(() => normalizeTronProposeCalls(TARGET_A, undefined, false)).toThrow(
      /--calldata/
    )
  })

  it('rejects non-hex calldata (viem would silently zero-pad it)', () => {
    expect(() =>
      normalizeTronProposeCalls(TARGET_A, 'deadbeef' as never, false)
    ).toThrow(/not well-formed hex/)
  })

  it('allows empty calldata (0x) for a single call', () => {
    const { calldatas } = normalizeTronProposeCalls(TARGET_A, '0x', false)
    expect(calldatas).toEqual(['0x'])
  })

  it('rejects empty calldata (0x) inside a multi-call batch', () => {
    expect(() =>
      normalizeTronProposeCalls(
        [TARGET_A, TARGET_B],
        [CALLDATA_REMOVE, '0x'],
        true
      )
    ).toThrow(/empty payloads are not allowed in multi-call/)
  })
})
