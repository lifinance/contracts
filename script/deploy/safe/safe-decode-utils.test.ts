/**
 * Tests for safe-decode-utils
 *
 * Run with: bun test script/deploy/safe/safe-decode-utils.test.ts
 */

// eslint-disable-next-line import/no-unresolved
import { describe, test, expect, beforeAll } from 'bun:test'
import type { Hex } from 'viem'

import { sampleTransactions } from './fixtures/sample-transactions'
import { decodeTransactionData, decodeNestedCall } from './safe-decode-utils'

// Fix BigInt serialization
beforeAll(() => {
  ;(BigInt.prototype as any).toJSON = function () {
    return this.toString()
  }
})

describe('safe-decode-utils', () => {
  test('should decode empty data', async () => {
    const result = await decodeTransactionData('0x' as Hex)
    expect(result.selector).toBe('0x')
    expect(result.functionName).toBeUndefined()
    expect(result.decodedVia).toBe('unknown')
  })

  test('should decode diamondCut selector', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.directDiamondCut.data
    )
    expect(result.selector).toBe(
      sampleTransactions.directDiamondCut.expectedSelector
    )
    // Function name will be resolved based on available data sources
    expect(result.functionName).toBeDefined()
  })

  test('should decode critical selector (schedule)', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.timelockSchedule.data
    )
    expect(result.selector).toBe('0x01d5062a')
    expect(result.functionName).toBe('schedule')
    expect(result.decodedVia).toBe('known') // Critical selectors are marked as 'known'
  })

  test('should decode nested timelock schedule call', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.timelockSchedule.data
    )
    expect(result.selector).toBe(
      sampleTransactions.timelockSchedule.expectedSelector
    )
    expect(result.functionName).toBe(
      sampleTransactions.timelockSchedule.expectedFunction
    )

    // Test nested call decoding - the data is in args[2] for timelock schedule
    const nestedData = result.args?.[2] // timelock schedule has data as 3rd param
    expect(nestedData).toBeDefined()

    const nestedResult = await decodeNestedCall(nestedData as Hex)
    expect(nestedResult.selector).toBe(
      sampleTransactions.timelockSchedule.expectedNestedSelector
    )
    expect(nestedResult.functionName).toBe(
      sampleTransactions.timelockSchedule.expectedNestedFunction
    )
  })
  test('should decode timelock schedule with diamond cut', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.timelockScheduleWithDiamondCut.data
    )
    expect(result.selector).toBe(
      sampleTransactions.timelockScheduleWithDiamondCut.expectedSelector
    )

    // Test nested call decoding - the data is in args[2] for timelock schedule
    const nestedData = result.args?.[2] // timelock schedule has data as 3rd param
    expect(nestedData).toBeDefined()

    const nestedResult = await decodeNestedCall(nestedData as Hex)
    expect(nestedResult.selector).toBe(
      sampleTransactions.timelockScheduleWithDiamondCut.expectedNestedSelector
    )
    // Check if we can decode the nested diamondCut
    expect(nestedResult.functionName).toBeDefined()
  })
  test('should handle unknown function gracefully', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.unknownFunction.data
    )
    expect(result.selector).toBe(
      sampleTransactions.unknownFunction.expectedSelector
    )
    // Function name might be undefined or resolved from external source
    expect(result.decodedVia).toBeDefined()
  })

  test('should decode real timelock diamondCut adding GasZipFacet', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.timelockDiamondCutGasZip.data
    )

    // Should decode as schedule
    expect(result.selector).toBe('0x01d5062a')
    expect(result.functionName).toBe('schedule')
    expect(result.decodedVia).toBe('known')

    // Should have decoded args
    expect(result.args).toBeDefined()
    expect(result.args?.length).toBe(6)

    // The nested diamondCut data is in args[2]
    const nestedData = result.args?.[2] as Hex
    expect(nestedData).toBeDefined()
    expect(nestedData.startsWith('0x1f931c1c')).toBe(true)

    // Decode the nested diamondCut
    const nestedResult = await decodeNestedCall(nestedData)
    expect(nestedResult.selector).toBe('0x1f931c1c')
    expect(nestedResult.functionName).toBe('diamondCut')
    expect(nestedResult.decodedVia).toBe('known')

    // Check if diamondCut args were decoded
    if (nestedResult.args) {
      // diamondCut has 3 parameters: facetCuts[], initAddress, initCalldata
      expect(nestedResult.args.length).toBe(3)

      // The facetCuts array should contain the GasZipFacet addition
      const facetCuts = nestedResult.args[0] as any[]
      expect(facetCuts).toBeDefined()
      expect(facetCuts.length).toBe(1) // Adding one facet

      const gasZipFacetCut = facetCuts[0]
      // With named parameters, the structure might be different
      // Check if it's an object with named properties or an array
      if (gasZipFacetCut && gasZipFacetCut.facetAddress) {
        // Named parameters
        expect(gasZipFacetCut.facetAddress.toLowerCase()).toBe(
          '0xc7ff0661c9ff1da5472e71e5ee6dadb6afa87d02'
        )
        expect(gasZipFacetCut.action).toBe(0) // FacetCutAction.Add
        expect(gasZipFacetCut.functionSelectors).toEqual(
          sampleTransactions.timelockDiamondCutGasZip.gasZipSelectors
        )
      } else if (gasZipFacetCut) {
        // Indexed array
        expect(gasZipFacetCut[0].toLowerCase()).toBe(
          '0xc7ff0661c9ff1da5472e71e5ee6dadb6afa87d02'
        ) // GasZipFacet address
        expect(gasZipFacetCut[1]).toBe(0) // FacetCutAction.Add
        expect(gasZipFacetCut[2]).toEqual(
          sampleTransactions.timelockDiamondCutGasZip.gasZipSelectors
        )
      }
    }
  })

  describe('network-specific deployment log resolution', () => {
    test('should use network parameter when provided', async () => {
      // This tests that the network parameter is passed through
      const result = await decodeTransactionData(
        sampleTransactions.unknownFunction.data,
        { network: 'mainnet' }
      )
      expect(result.selector).toBe(
        sampleTransactions.unknownFunction.expectedSelector
      )
    })
  })

  describe('error handling', () => {
    test('should handle malformed hex data', async () => {
      const result = await decodeTransactionData('0xINVALID' as Hex)
      expect(result.selector).toBe('0xINVALID')
      expect(result.functionName).toBeUndefined()
      expect(result.decodedVia).toBe('unknown')
    })

    test('should handle truncated data', async () => {
      const result = await decodeTransactionData('0x1f93' as Hex)
      expect(result.selector).toBe('0x1f93')
      expect(result.functionName).toBeUndefined()
      expect(result.decodedVia).toBe('unknown')
    })

    test('should handle null/undefined gracefully', async () => {
      const result = await decodeTransactionData(null as unknown as Hex)
      expect(result.selector).toBe('0x')
      expect(result.functionName).toBeUndefined()
      expect(result.decodedVia).toBe('unknown')
    })

    test('should continue if external API fails', async () => {
      // Mock fetch to simulate API failure
      const originalFetch = global.fetch
      global.fetch = (async () => {
        throw new Error('Network error')
      }) as unknown as typeof fetch

      const result = await decodeTransactionData(
        sampleTransactions.unknownFunction.data
      )

      expect(result.selector).toBe(
        sampleTransactions.unknownFunction.expectedSelector
      )
      expect(result.decodedVia).toBe('unknown')

      global.fetch = originalFetch
    })
  })

  describe('max depth limiting', () => {
    test('should respect maxDepth option', async () => {
      const result = await decodeTransactionData(
        sampleTransactions.timelockSchedule.data,
        { maxDepth: 0 }
      )

      // With maxDepth 0, no nested calls should be decoded
      expect(result.nestedCall).toBeUndefined()
    })

    test('should limit recursion depth', async () => {
      // Create deeply nested data
      const deeplyNestedData = sampleTransactions.timelockSchedule.data

      const result = await decodeNestedCall(deeplyNestedData, 3, 3)

      // At max depth, should return basic info without nested calls
      expect(result.selector).toBeDefined()
      expect(result.functionName).toBe('schedule') // Still decodes the function
      expect(result.decodedVia).toBe('known') // Still uses known selector
      expect(result.nestedCall).toBeUndefined() // But no nested calls at max depth
    })
    test('should decode with proper args for manual nested extraction', async () => {
      const result = await decodeTransactionData(
        sampleTransactions.timelockSchedule.data
      )

      expect(result.functionName).toBe('schedule')
      expect(result.args).toBeDefined()
      expect(result.args?.length).toBe(6) // schedule has 6 parameters

      // The nested call data is in args[2]
      const nestedData = result.args?.[2]
      expect(nestedData).toBe('0x7200b829') // confirmOwnershipTransfer selector
    })
  })
})
