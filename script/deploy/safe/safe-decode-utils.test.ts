/**
 * Tests for safe-decode-utils
 *
 * Run with: bun test script/deploy/safe/safe-decode-utils.test.ts
 */

import type { Hex } from 'viem'

import { sampleTransactions } from './fixtures/sample-transactions'
import { decodeTransactionData, decodeNestedCall } from './safe-decode-utils'

// Fix BigInt serialization
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

// Simple test runner
async function runTests() {
  console.log('Running safe-decode-utils tests...\n')

  let passed = 0
  let failed = 0

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn()
      console.log(`✅ ${name}`)
      passed++
    } catch (error) {
      console.log(`❌ ${name}`)
      console.error(`   ${error}`)
      failed++
    }
  }

  function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message)
  }

  function assertEqual(actual: any, expected: any, message?: string) {
    if (actual !== expected)
      throw new Error(message || `Expected ${expected} but got ${actual}`)
  }

  // Test: decode empty data
  await test('should decode empty data', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.emptyData.data
    )
    assertEqual(result.selector, '0x', 'selector should be 0x')
    assertEqual(result.decodedVia, 'unknown', 'decodedVia should be unknown')
    assert(
      result.functionName === undefined,
      'functionName should be undefined'
    )
  })

  // Test: decode known selector
  await test('should decode known selector from knownSelectors.json', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.erc20Transfer.data
    )
    assertEqual(
      result.selector,
      sampleTransactions.erc20Transfer.expectedSelector,
      'selector mismatch'
    )
    assertEqual(
      result.functionName,
      sampleTransactions.erc20Transfer.expectedFunction,
      'function name mismatch'
    )
    assertEqual(result.decodedVia, 'known', 'should be decoded via known')
  })

  // Test: decode diamondCut
  await test('should decode diamondCut selector', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.directDiamondCut.data
    )
    assertEqual(
      result.selector,
      sampleTransactions.directDiamondCut.expectedSelector,
      'selector mismatch'
    )
    // Function name will be resolved based on available data sources
    if (result.functionName)
      console.log(
        `   Decoded as: ${result.functionName} via ${result.decodedVia}`
      )
  })

  // Test: decode nested timelock call
  await test('should decode nested timelock schedule call', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.timelockSchedule.data
    )
    assertEqual(
      result.selector,
      sampleTransactions.timelockSchedule.expectedSelector,
      'selector mismatch'
    )
    assertEqual(
      result.functionName,
      sampleTransactions.timelockSchedule.expectedFunction,
      'function name mismatch'
    )

    // Check nested call
    assert(result.nestedCall !== undefined, 'should have nested call')
    if (result.nestedCall) {
      assertEqual(
        result.nestedCall.selector,
        sampleTransactions.timelockSchedule.expectedNestedSelector,
        'nested selector mismatch'
      )
      console.log(
        `   Nested function: ${
          result.nestedCall.functionName || 'unknown'
        } via ${result.nestedCall.decodedVia}`
      )
    }
  })

  // Test: handle unknown selector
  await test('should handle unknown selector', async () => {
    const result = await decodeTransactionData(
      sampleTransactions.unknownFunction.data
    )
    assertEqual(
      result.selector,
      sampleTransactions.unknownFunction.expectedSelector,
      'selector mismatch'
    )
    // Function name might be resolved via external API
    console.log(`   Decoded via: ${result.decodedVia}`)
  })

  // Test: respect max depth
  await test('should respect max depth limit', async () => {
    const result = await decodeNestedCall(
      sampleTransactions.timelockSchedule.data,
      1, // currentDepth = 1 (already at max)
      1 // maxDepth = 1
    )
    assert(
      result.nestedCall === undefined,
      'should not have nested call at max depth'
    )
  })

  // Test: handle malformed data
  await test('should handle malformed selector', async () => {
    const shortData = '0x1234' as Hex
    const result = await decodeTransactionData(shortData)
    assertEqual(result.selector, '0x1234', 'selector should match input')
    assertEqual(result.decodedVia, 'unknown', 'should be unknown')
  })

  // Test: concurrent requests
  await test('should handle concurrent decoding requests', async () => {
    const promises = [
      decodeTransactionData(sampleTransactions.erc20Transfer.data),
      decodeTransactionData(sampleTransactions.erc20Approve.data),
      decodeTransactionData(sampleTransactions.directDiamondCut.data),
    ]

    const results = await Promise.all(promises)

    if (results[0])
      assertEqual(
        results[0].functionName,
        'transfer',
        'first should be transfer'
      )

    if (results[1])
      assertEqual(
        results[1].functionName,
        'approve',
        'second should be approve'
      )

    if (results[2])
      assertEqual(
        results[2].selector,
        '0x1f931c1c',
        'third selector should match'
      )
  })

  // Summary
  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) process.exit(1)
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`)
  runTests().catch(console.error)
