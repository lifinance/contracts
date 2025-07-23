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

  test('should decode known selector from knownSelectors.json', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.erc20Transfer.data
    )
    expect(result.selector).toBe(
      sampleTransactions.erc20Transfer.expectedSelector
    )
    expect(result.functionName).toBe(
      sampleTransactions.erc20Transfer.expectedFunction
    )
    expect(result.decodedVia).toBe('known')
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
})
