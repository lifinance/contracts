/**
 * Unit tests for troncast output formatting helpers.
 *
 * Focus: formatReceipt, which renders a Tron transaction receipt as the multi-line block that
 * `troncast send` prints. Covers the success default, failed receipts with a revert message,
 * falsy optional fields, and zero resource usage.
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
  blockNumber: 61234567,
  energy_usage: 1200,
  energy_usage_total: 15000,
  net_usage: 345,
}

describe('formatReceipt', () => {
  it('renders every field in order and defaults the status to SUCCESS', () => {
    expect(formatReceipt(baseReceipt)).toBe(
      [
        'Transaction ID: abc123',
        'Block Number: 61234567',
        'Energy Used: 1200',
        'Energy Total: 15000',
        'Bandwidth Used: 345',
        'Status: SUCCESS',
      ].join('\n')
    )
  })

  it('shows an explicit result instead of the default', () => {
    const lines = formatReceipt({ ...baseReceipt, result: 'SUCCESS' }).split(
      '\n'
    )
    expect(lines).toHaveLength(6)
    expect(lines[5]).toBe('Status: SUCCESS')
  })

  it('shows a failed result and appends the revert message', () => {
    const lines = formatReceipt({
      ...baseReceipt,
      result: 'REVERT',
      resMessage: 'execution reverted: NotAuthorized',
    }).split('\n')
    expect(lines).toHaveLength(7)
    expect(lines[5]).toBe('Status: REVERT')
    expect(lines[6]).toBe('Message: execution reverted: NotAuthorized')
  })

  it('appends the message even when no result is set', () => {
    const lines = formatReceipt({
      ...baseReceipt,
      resMessage: 'note',
    }).split('\n')
    expect(lines[5]).toBe('Status: SUCCESS')
    expect(lines[6]).toBe('Message: note')
  })

  it('treats an empty result as SUCCESS and omits an empty message', () => {
    const output = formatReceipt({ ...baseReceipt, result: '', resMessage: '' })
    expect(output.split('\n')).toHaveLength(6)
    expect(output).toContain('Status: SUCCESS')
    expect(output).not.toContain('Message:')
  })

  it('prints zero resource usage as 0 rather than dropping it', () => {
    const output = formatReceipt({
      ...baseReceipt,
      energy_usage: 0,
      energy_usage_total: 0,
      net_usage: 0,
    })
    expect(output).toContain('Energy Used: 0')
    expect(output).toContain('Energy Total: 0')
    expect(output).toContain('Bandwidth Used: 0')
  })

  it('prints missing numeric fields as undefined from loosely typed RPC data', () => {
    const output = formatReceipt({
      id: 'partial',
    } as unknown as ITransactionReceipt)
    expect(output).toContain('Transaction ID: partial')
    expect(output).toContain('Block Number: undefined')
    expect(output).toContain('Status: SUCCESS')
  })
})
