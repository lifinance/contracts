/**
 * Tests for confirm-safe-tx utility functions
 *
 * Run with: bun test script/deploy/safe/confirm-safe-tx.test.ts
 */

// eslint-disable-next-line import/no-unresolved
import { describe, test, expect } from 'bun:test'
import type { Hex } from 'viem'

import {
  extractTimelockDetails,
  prepareNestedCallDisplay,
  formatTransactionDisplay,
  formatArgument,
  formatSafeTransactionDetails,
  type ISafeTransactionDetails,
} from './confirm-safe-tx-utils'
import type { IDecodedTransaction } from './safe-decode-utils'

describe('confirm-safe-tx utilities', () => {
  describe('extractTimelockDetails', () => {
    test('should extract timelock details from schedule function', () => {
      const decoded: IDecodedTransaction = {
        functionName: 'schedule',
        selector: '0x01d5062a',
        args: [
          '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', // target
          '0', // value
          '0x1f931c1c', // data
          '0x0000000000000000000000000000000000000000000000000000000000000000', // predecessor
          '0x0000000000000000000000000000000000000000000000000000019836bd9998', // salt
          '10800', // delay
        ],
        decodedVia: 'known',
      }

      const result = extractTimelockDetails(decoded)

      expect(result).not.toBeNull()
      expect(result?.target).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
      expect(result?.value).toBe('0')
      expect(result?.data).toBe('0x1f931c1c')
      expect(result?.delay).toBe('10800')
    })

    test('should return null for non-schedule functions', () => {
      const decoded: IDecodedTransaction = {
        functionName: 'diamondCut',
        selector: '0x1f931c1c',
        args: [],
        decodedVia: 'known',
      }

      const result = extractTimelockDetails(decoded)
      expect(result).toBeNull()
    })

    test('should return null if args are missing', () => {
      const decoded: IDecodedTransaction = {
        functionName: 'schedule',
        selector: '0x01d5062a',
        decodedVia: 'known',
      }

      const result = extractTimelockDetails(decoded)
      expect(result).toBeNull()
    })

    test('should include nested call if present', () => {
      const nestedCall: IDecodedTransaction = {
        functionName: 'diamondCut',
        selector: '0x1f931c1c',
        decodedVia: 'known',
      }

      const decoded: IDecodedTransaction = {
        functionName: 'schedule',
        selector: '0x01d5062a',
        args: [
          '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
          '0',
          '0x1f931c1c',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          '0x0000000000000000000000000000000000000000000000000000019836bd9998',
          '10800',
        ],
        decodedVia: 'known',
        nestedCall,
      }

      const result = extractTimelockDetails(decoded)
      expect(result?.nestedCall).toBe(nestedCall)
    })
  })

  describe('prepareNestedCallDisplay', () => {
    test('should prepare basic nested call display', async () => {
      const nested: IDecodedTransaction = {
        functionName: 'transfer',
        selector: '0xa9059cbb',
        contractName: 'ERC20',
        decodedVia: 'external',
        args: ['0x742d35cc6634c0532925a3b844bc9e7595f8e2dc', '100'],
      }

      const result = await prepareNestedCallDisplay(nested, 1)

      expect(result.functionName).toBe('transfer')
      expect(result.contractName).toBe('ERC20')
      expect(result.decodedVia).toBe('external')
      expect(result.args).toEqual([
        '0x742d35cc6634c0532925a3b844bc9e7595f8e2dc',
        '100',
      ])
    })

    test('should handle diamondCut with args', async () => {
      const nested: IDecodedTransaction = {
        functionName: 'diamondCut',
        selector: '0x1f931c1c',
        decodedVia: 'known',
        args: [
          [], // facetCuts
          '0x0000000000000000000000000000000000000000', // init
          '0x', // calldata
        ],
      }

      const result = await prepareNestedCallDisplay(nested, 1)

      expect(result.functionName).toBe('diamondCut')
      expect(result.diamondCutData).toBeDefined()
      expect(result.diamondCutData.functionName).toBe('diamondCut')
      expect(result.diamondCutData.args).toEqual(nested.args)
    })

    test('should handle unknown function with selector only', async () => {
      const nested: IDecodedTransaction = {
        selector: '0x12345678',
        decodedVia: 'unknown',
      }

      const result = await prepareNestedCallDisplay(nested, 1)

      expect(result.functionName).toBe('0x12345678')
      expect(result.decodedVia).toBe('unknown')
    })

    test('should handle decoding errors gracefully', async () => {
      const nested: IDecodedTransaction = {
        functionName: 'diamondCut',
        selector: '0x1f931c1c',
        decodedVia: 'known',
        rawData: '0xinvalid' as Hex,
        // No args, so it will try to decode
      }

      const result = await prepareNestedCallDisplay(nested, 1)

      expect(result.error).toBeDefined()
      expect(result.error).toContain('Failed to decode diamondCut')
    })

    test('should return error when no ABI found for diamondCut', async () => {
      const nested: IDecodedTransaction = {
        functionName: 'diamondCut',
        selector: '0xunknown',
        decodedVia: 'unknown',
        rawData: '0x1234' as Hex,
      }

      const result = await prepareNestedCallDisplay(nested, 1)

      expect(result.error).toBe(
        'Failed to decode diamondCut: Unknown signature'
      )
    })
  })

  describe('formatTransactionDisplay', () => {
    test('should format regular function with arguments', () => {
      const decodedTx: IDecodedTransaction = {
        functionName: 'transfer',
        selector: '0xa9059cbb',
        contractName: 'ERC20',
        decodedVia: 'external',
      }
      const decoded = {
        functionName: 'transfer',
        args: ['0x742d35cc6634c0532925a3b844bc9e7595f8e2dc', BigInt(1000)],
      }

      const result = formatTransactionDisplay(decodedTx, decoded)

      expect(result.type).toBe('regular')
      expect(result.lines).toContain('Function: transfer')
      expect(result.lines).toContain('Contract: ERC20')
      expect(result.lines).toContain('Decoded via: external')
      expect(result.lines).toContain('Function Name: transfer')
      expect(result.lines).toContain('Decoded Arguments:')
      expect(result.lines).toContain(
        '  [0]: 0x742d35cc6634c0532925a3b844bc9e7595f8e2dc'
      )
      expect(result.lines).toContain('  [1]: 1000')
    })

    test('should format diamondCut function', () => {
      const decodedTx: IDecodedTransaction = {
        functionName: 'diamondCut',
        selector: '0x1f931c1c',
        decodedVia: 'known',
      }

      const result = formatTransactionDisplay(decodedTx)

      expect(result.type).toBe('diamondCut')
      expect(result.lines).toContain('Function: diamondCut')
      expect(result.lines).toContain('Decoded via: known')
    })

    test('should format schedule function', () => {
      const decodedTx: IDecodedTransaction = {
        functionName: 'schedule',
        selector: '0x01d5062a',
        decodedVia: 'known',
      }

      const result = formatTransactionDisplay(decodedTx)

      expect(result.type).toBe('schedule')
      expect(result.lines).toContain('Function: schedule')
      expect(result.lines).toContain('Decoded via: known')
    })

    test('should format unknown function', () => {
      const decodedTx: IDecodedTransaction = {
        selector: '0x12345678',
        decodedVia: 'unknown',
      }

      const result = formatTransactionDisplay(decodedTx)

      expect(result.type).toBe('unknown')
      expect(result.lines).toContain(
        'Unknown function with selector: 0x12345678'
      )
      expect(result.lines).toContain('Decoded via: unknown')
    })

    test('should handle null decoded transaction', () => {
      const result = formatTransactionDisplay(null)

      expect(result.type).toBe('unknown')
      expect(result.lines).toContain('Failed to decode transaction')
    })

    test('should handle function with no arguments', () => {
      const decodedTx: IDecodedTransaction = {
        functionName: 'pause',
        selector: '0x8456cb59',
        decodedVia: 'known',
      }
      const decoded = {
        functionName: 'pause',
        args: [],
      }

      const result = formatTransactionDisplay(decodedTx, decoded)

      expect(result.type).toBe('regular')
      expect(result.lines).toContain(
        'No arguments or failed to decode arguments'
      )
    })
  })

  describe('formatArgument', () => {
    test('should format bigint values', () => {
      const result = formatArgument(BigInt('1000000000000000000'))
      expect(result).toBe('1000000000000000000')
    })

    test('should format objects as JSON', () => {
      const obj = { key: 'value', nested: { prop: 123 } }
      const result = formatArgument(obj)
      expect(result).toBe(JSON.stringify(obj))
    })

    test('should format arrays as JSON', () => {
      const arr = [1, 2, 3, 'test']
      const result = formatArgument(arr)
      expect(result).toBe(JSON.stringify(arr))
    })

    test('should format strings as-is', () => {
      const result = formatArgument('test string')
      expect(result).toBe('test string')
    })

    test('should format numbers as strings', () => {
      const result = formatArgument(42)
      expect(result).toBe('42')
    })

    test('should format null as "null"', () => {
      const result = formatArgument(null)
      expect(result).toBe('null')
    })

    test('should format undefined as "undefined"', () => {
      const result = formatArgument(undefined)
      expect(result).toBe('undefined')
    })
  })

  describe('formatSafeTransactionDetails', () => {
    test('should format Safe transaction details correctly', () => {
      const details: ISafeTransactionDetails = {
        nonce: 5,
        to: '0x1234567890123456789012345678901234567890',
        value: '0',
        operation: 'Call',
        data: '0xa9059cbb000000...',
        proposer: '0xProposerAddress',
        safeTxHash: '0xSafeTxHash',
        signatures: '2/3',
        executionReady: false,
      }

      const result = formatSafeTransactionDetails(details)

      expect(result).toContain('Safe Transaction Details:')
      expect(result).toContain('    Nonce:           5')
      expect(result).toContain(
        '    To:              0x1234567890123456789012345678901234567890'
      )
      expect(result).toContain('    Value:           0')
      expect(result).toContain('    Operation:       Call')
      expect(result).toContain('    Data:            0xa9059cbb000000...')
      expect(result).toContain('    Proposer:        0xProposerAddress')
      expect(result).toContain('    Safe Tx Hash:    0xSafeTxHash')
      expect(result).toContain('    Signatures:      2/3')
      expect(result).toContain('    Execution Ready: ✗')
    })

    test('should show checkmark for execution ready', () => {
      const details: ISafeTransactionDetails = {
        nonce: 10,
        to: '0xabcdef',
        value: '1000000000000000000',
        operation: 'DelegateCall',
        data: '0x',
        proposer: '0xProposer',
        safeTxHash: '0xHash',
        signatures: '3/3',
        executionReady: true,
      }

      const result = formatSafeTransactionDetails(details)

      expect(result).toContain('    Execution Ready: ✓')
    })
  })
})
