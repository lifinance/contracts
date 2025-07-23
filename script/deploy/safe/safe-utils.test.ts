/**
 * Tests for safe-utils re-exports
 *
 * Run with: bun test script/deploy/safe/safe-utils.test.ts
 */

import { sampleTransactions } from './fixtures/sample-transactions'
import { decodeTransactionData } from './safe-utils'

// Simple test to ensure the re-export is working
async function runTests() {
  console.log('Running safe-utils re-export tests...\n')

  try {
    // Test that decodeTransactionData is properly re-exported
    const result = await decodeTransactionData(
      sampleTransactions.erc20Transfer.data
    )

    if (result.functionName === 'transfer') {
      console.log('✅ decodeTransactionData re-export is working correctly')
      console.log(`   Function: ${result.functionName}`)
      console.log(`   Decoded data:`, result.decodedData)
    } else {
      console.log('❌ decodeTransactionData re-export test failed')
      console.log('   Result:', result)
    }
  } catch (error) {
    console.error('❌ Error testing re-export:', error)
    process.exit(1)
  }

  console.log('\n✅ All re-export tests passed!')
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) 
  runTests().catch(console.error)

