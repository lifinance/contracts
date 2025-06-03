/**
 * Test Ledger Connection
 *
 * This script tests the connection to a Ledger device by:
 * 1. Getting the Ethereum address
 * 2. Signing a test message
 * 3. Displaying the results
 *
 * Usage:
 * bun script/deploy/safe/test-ledger.ts
 */

import consola from 'consola'
import type { Hex } from 'viem'

import { getLedgerAccount } from './ledger'

async function main() {
  try {
    consola.info('=== Ledger Connection Test ===')
    consola.info('Connecting to Ledger device...')
    consola.info(
      'Please connect your Ledger, unlock it, and open the Ethereum app'
    )

    // Get Ledger account
    const account = await getLedgerAccount({
      // Use Ledger Live derivation path by default
      ledgerLive: true,
      accountIndex: 0,
    })

    consola.success(`✅ Connected to Ledger`)
    consola.success(`📍 Address: ${account.address}`)

    // Ask for confirmation to sign a test message
    consola.info('Now we will test message signing')
    consola.info(
      'Please confirm the signature request on your Ledger device...'
    )

    // Sign a test message
    const testMessage = 'Hello from LiFi! ' + new Date().toISOString()
    const signature = await account.signMessage({ message: testMessage })

    // Display the results
    consola.success('✅ Message successfully signed!')
    consola.log('')
    consola.info('📝 Message:')
    consola.log(testMessage)
    consola.info('🔏 Signature:')
    consola.log(signature)

    // Test transaction hash signing
    consola.info('Now testing transaction hash signing...')
    consola.info(
      'Please confirm the signature request on your Ledger device...'
    )

    const testHash: Hex =
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    const hashSignature = await account.signMessage({
      message: { raw: testHash },
    })

    consola.success('✅ Hash successfully signed!')
    consola.log('')
    consola.info('📝 Hash:')
    consola.log(testHash)
    consola.info('🔏 Signature:')
    consola.log(hashSignature)

    // Done
    consola.success('⭐️ Test completed successfully!')
  } catch (error) {
    consola.error('❌ Error testing Ledger connection:')
    consola.error(error)
    process.exit(1)
  }
}

// Run the main function
main().catch((error) => {
  consola.error(error)
  process.exit(1)
})
