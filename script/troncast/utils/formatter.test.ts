/**
 * Unit tests for troncast output formatting helpers.
 *
 * Focus: formatReceipt, which renders a Tron transaction receipt as the multi-line summary printed
 * by `troncast send`. Covers the field order, the SUCCESS fallback for a missing or empty result,
 * the optional Message line, and a missing receipt.
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
  blockNumber: 60000000,
  energy_usage: 1200,
  energy_usage_total: 15000,
  net_usage: 345,
}

describe('formatReceipt', () => {
  it('renders every field in order and defaults the status to SUCCESS', () => {
    expect(formatReceipt(baseReceipt)).toBe(
      [
        'Transaction ID: abc123',
        'Block Number: 60000000',
        'Energy Used: 1200',
        'Energy Total: 15000',
        'Bandwidth Used: 345',
        'Status: SUCCESS',
      ].join('\n')
    )
  })

  it('shows the receipt result as the status when present', () => {
    const lines = formatReceipt({ ...baseReceipt, result: 'REVERT' }).split(
      '\n'
    )

    expect(lines).toHaveLength(6)
    expect(lines[5]).toBe('Status: REVERT')
  })

  it('falls back to SUCCESS when the result is an empty string', () => {
    expect(formatReceipt({ ...baseReceipt, result: '' })).toEndWith(
      'Status: SUCCESS'
    )
  })

  it('appends the resource message as a final line when present', () => {
    const lines = formatReceipt({
      ...baseReceipt,
      result: 'OUT_OF_ENERGY',
      resMessage: 'Not enough energy',
    }).split('\n')

    expect(lines).toHaveLength(7)
    expect(lines[5]).toBe('Status: OUT_OF_ENERGY')
    expect(lines[6]).toBe('Message: Not enough energy')
  })

  it('omits the message line when the resource message is empty', () => {
    const output = formatReceipt({ ...baseReceipt, resMessage: '' })

    expect(output).not.toContain('Message:')
    expect(output.split('\n')).toHaveLength(6)
  })

  it('renders zero usage values rather than dropping them', () => {
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

  it('prints undefined for fields missing from a partial node response', () => {
    const partial = { id: 'abc123' } as ITransactionReceipt

    expect(formatReceipt(partial)).toContain('Energy Used: undefined')
  })

  it('throws a TypeError when no receipt is given', () => {
    expect(() =>
      formatReceipt(undefined as unknown as ITransactionReceipt)
    ).toThrow(TypeError)
  })
})
