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
})
