/**
 * Unit tests for troncast output formatting helpers.
 *
 * Focus: formatReceipt, which renders a Tron transaction receipt as the multi-line summary printed
 * by `troncast send`. Covers the success default, explicit failure status, the optional message
 * line, zero-valued resource fields, and a missing receipt.
 */
import {
  describe,
  it,
  expect,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { ITransactionReceipt } from '../types'

import { formatReceipt } from './formatter'

const baseReceipt: ITransactionReceipt = {
  id: 'abc123',
  blockNumber: 65000000,
  energy_usage: 1200,
  energy_usage_total: 34500,
  net_usage: 345,
}

describe('formatReceipt', () => {
  it('renders every field and defaults the status to SUCCESS', () => {
    expect(formatReceipt(baseReceipt)).toBe(
      [
        'Transaction ID: abc123',
        'Block Number: 65000000',
        'Energy Used: 1200',
        'Energy Total: 34500',
        'Bandwidth Used: 345',
        'Status: SUCCESS',
      ].join('\n')
    )
  })

  it('shows an explicit result and appends the message line', () => {
    const output = formatReceipt({
      ...baseReceipt,
      result: 'FAILED',
      resMessage: 'REVERT opcode executed',
    })

    const lines = output.split('\n')
    expect(lines).toHaveLength(7)
    expect(lines[5]).toBe('Status: FAILED')
    expect(lines[6]).toBe('Message: REVERT opcode executed')
  })

  it('falls back to SUCCESS when result is an empty string', () => {
    expect(formatReceipt({ ...baseReceipt, result: '' })).toContain(
      'Status: SUCCESS'
    )
  })

  it('omits the message line when resMessage is empty', () => {
    const output = formatReceipt({ ...baseReceipt, resMessage: '' })

    expect(output).not.toContain('Message:')
    expect(output.split('\n')).toHaveLength(6)
  })

  it('renders zero-valued resource fields as 0 rather than dropping them', () => {
    const output = formatReceipt({
      ...baseReceipt,
      blockNumber: 0,
      energy_usage: 0,
      energy_usage_total: 0,
      net_usage: 0,
    })

    expect(output).toContain('Block Number: 0')
    expect(output).toContain('Energy Used: 0')
    expect(output).toContain('Energy Total: 0')
    expect(output).toContain('Bandwidth Used: 0')
  })

  it('throws a TypeError when no receipt is given', () => {
    expect(() =>
      formatReceipt(undefined as unknown as ITransactionReceipt)
    ).toThrow(TypeError)
  })
})
