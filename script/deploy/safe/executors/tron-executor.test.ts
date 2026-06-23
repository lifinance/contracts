import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { resolveTronExecutionStatus } from './tron-executor'

describe('resolveTronExecutionStatus', () => {
  it("returns 'success' when receipt.result is 'SUCCESS'", () => {
    expect(resolveTronExecutionStatus({ receipt: { result: 'SUCCESS' } })).toBe(
      'success'
    )
  })

  it("returns 'success' when receipt.result is unset (Tron omits it on success)", () => {
    expect(resolveTronExecutionStatus({ receipt: {} })).toBe('success')
    expect(resolveTronExecutionStatus({ receipt: { result: undefined } })).toBe(
      'success'
    )
  })

  it("returns 'reverted' for any failure result", () => {
    for (const result of [
      'REVERT',
      'FAILED',
      'OUT_OF_ENERGY',
      'OUT_OF_TIME',
      'BAD_JUMP_DESTINATION',
    ])
      expect(resolveTronExecutionStatus({ receipt: { result } })).toBe(
        'reverted'
      )
  })

  it("returns 'success' for missing / malformed info rather than throwing", () => {
    expect(resolveTronExecutionStatus(undefined)).toBe('success')
    expect(resolveTronExecutionStatus(null)).toBe('success')
    expect(resolveTronExecutionStatus({})).toBe('success')
    expect(resolveTronExecutionStatus('not-an-object')).toBe('success')
    expect(resolveTronExecutionStatus({ receipt: { result: 42 } })).toBe(
      'success'
    )
  })
})
