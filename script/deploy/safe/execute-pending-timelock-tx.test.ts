import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { classifyBlockedRow } from './execute-pending-timelock-tx'

describe('classifyBlockedRow', () => {
  it('reconciles a blocked op the controller already executed', () => {
    expect(
      classifyBlockedRow({
        isDone: true,
        isPending: false,
        isReady: false,
        isOperation: true,
      })
    ).toBe('done')
  })

  // The worldchain shape observed in production: the operator followed the
  // guard's "cancel and re-propose" advice, so the controller dropped the
  // timestamp and isOperation went false — but the queue row never moved.
  it('reconciles a blocked op the controller no longer knows about', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: false,
        isReady: false,
        isOperation: false,
      })
    ).toBe('gone')
  })

  // The EXSC-816 shape: delay elapsed, still scheduled, still un-executed.
  it('keeps a ready op as a live candidate for alerting', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: true,
        isReady: true,
        isOperation: true,
      })
    ).toBe('pending')
  })

  it('keeps an op still inside its delay as a live candidate', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: true,
        isReady: false,
        isOperation: true,
      })
    ).toBe('pending')
  })

  // Guard against a contradictory read (e.g. a mid-block RPC race) being
  // classified as gone and silently marked cancelled.
  it('does not treat a contradictory read as gone', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: false,
        isReady: true,
        isOperation: false,
      })
    ).toBe('pending')
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: true,
        isReady: false,
        isOperation: false,
      })
    ).toBe('pending')
  })

  it('prefers done over every other signal', () => {
    expect(
      classifyBlockedRow({
        isDone: true,
        isPending: true,
        isReady: true,
        isOperation: false,
      })
    ).toBe('done')
  })
})
