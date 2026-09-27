/**
 * Unit tests for troncast output formatting helpers.
 *
 * Focus: formatReceipt, which renders a Tron transaction receipt as the multi-line summary
 * printed after `troncast send`. Covers the default SUCCESS status, explicit failure results,
 * the optional message line, and falsy/zero field values.
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
  blockNumber: 12345678,
  energy_usage: 100,
  energy_usage_total: 250,
  net_usage: 345,
}

describe('formatReceipt', () => {
  it('renders every field and defaults the status to SUCCESS', () => {
    expect(formatReceipt(baseReceipt)).toBe(
      [
        'Transaction ID: abc123',
        'Block Number: 12345678',
        'Energy Used: 100',
        'Energy Total: 250',
        'Bandwidth Used: 345',
        'Status: SUCCESS',
      ].join('\n')
    )
  })

  it('shows an explicit result instead of the default status', () => {
    const lines = formatReceipt({ ...baseReceipt, result: 'REVERT' }).split(
      '\n'
    )

    expect(lines).toHaveLength(6)
    expect(lines[5]).toBe('Status: REVERT')
  })

  it('appends the message line after the status when resMessage is set', () => {
    const lines = formatReceipt({
      ...baseReceipt,
      result: 'OUT_OF_ENERGY',
      resMessage: 'Not enough energy',
    }).split('\n')

    expect(lines).toHaveLength(7)
    expect(lines[5]).toBe('Status: OUT_OF_ENERGY')
    expect(lines[6]).toBe('Message: Not enough energy')
  })

  it('treats an empty result as SUCCESS and omits an empty resMessage', () => {
    const output = formatReceipt({
      ...baseReceipt,
      result: '',
      resMessage: '',
    })

    expect(output.split('\n')).toHaveLength(6)
    expect(output).toContain('Status: SUCCESS')
    expect(output).not.toContain('Message:')
  })

  it('prints zero usage values rather than dropping them', () => {
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

  it('renders missing numeric fields as undefined without throwing', () => {
    const partial = { id: 'partial' } as ITransactionReceipt

    expect(() => formatReceipt(partial)).not.toThrow()
    expect(formatReceipt(partial)).toContain('Energy Used: undefined')
  })
})
