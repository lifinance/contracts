/**
 * Create Safe
 *
 * This script creates a new Safe instance with a single owner
 * using the createProxyWithNonce method on SafeProxyFactory
 */

import {
  Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  decodeEventLog,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import consola from 'consola'

// Safe factory contract ABI
const SAFE_PROXY_FACTORY_ABI = [
  {
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'proxy', type: 'address' },
      { indexed: false, name: 'singleton', type: 'address' },
    ],
    name: 'ProxyCreation',
    type: 'event',
  },
] as const

// Safe singleton ABI for setup function
const SAFE_SETUP_ABI = [
  {
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)
  const parsedArgs: Record<string, string> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg.startsWith('--')) {
      const key = arg.substring(2)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        parsedArgs[key] = args[i + 1]
        i++
      } else {
        parsedArgs[key] = 'true'
      }
    }
  }

  // Check for required arguments
  const requiredArgs = [
    'safeProxyFactory',
    'safeSingleton',
    'rpcUrl',
    'privateKey',
  ]
  const missingArgs = requiredArgs.filter((arg) => !parsedArgs[arg])

  if (missingArgs.length > 0) {
    consola.error(`Missing required arguments: ${missingArgs.join(', ')}`)

    // Show help
    consola.info('Usage: bun create-safe.ts [options]')
    consola.info('')
    consola.info('Options:')
    consola.info(
      '  --safeProxyFactory   Address of the Safe Proxy Factory contract'
    )
    consola.info(
      '  --safeSingleton      Address of the Safe Singleton (implementation) contract'
    )
    consola.info('  --rpcUrl             RPC URL for the blockchain network')
    consola.info(
      '  --privateKey         Private key to use for deployment and as Safe owner'
    )
    consola.info('')
    consola.info('Example:')
    consola.info(
      '  bun create-safe.ts --safeProxyFactory 0x123... --safeSingleton 0x456... --rpcUrl https://rpc.example.com --privateKey 0x789...'
    )

    process.exit(1)
  }

  return parsedArgs
}

// Main function to create a Safe
async function createSafe() {
  const args = parseArgs()

  const safeProxyFactory = args.safeProxyFactory as Address
  const safeSingleton = args.safeSingleton as Address
  const rpcUrl = args.rpcUrl
  const privateKey = args.privateKey.startsWith('0x')
    ? args.privateKey
    : `0x${args.privateKey}`

  consola.info('Creating new Safe instance:')
  consola.info(`- Safe Proxy Factory: ${safeProxyFactory}`)
  consola.info(`- Safe Singleton: ${safeSingleton}`)
  consola.info(`- RPC URL: ${rpcUrl}`)

  // Create Viem client
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  })

  // Create wallet client for signing transactions
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  })

  consola.info(`Deployer account: ${account.address}`)

  // Create owners array (just the owner from the private key)
  const owners = [account.address]
  const threshold = 1n

  // Prepare initializer calldata for the new Safe (setup function)
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      owners, // _owners
      threshold, // _threshold
      '0x0000000000000000000000000000000000000000', // to (no initial transaction)
      '0x', // data (empty)
      '0x0000000000000000000000000000000000000000', // fallbackHandler (none)
      '0x0000000000000000000000000000000000000000', // paymentToken (none)
      0n, // payment
      '0x0000000000000000000000000000000000000000', // paymentReceiver
    ],
  })

  // Generate a unique salt based on timestamp
  const saltNonce = BigInt(Math.floor(Date.now() / 1000))

  try {
    consola.start('Creating Safe proxy...')

    // Call createProxyWithNonce on the factory contract
    const txHash = await walletClient.writeContract({
      address: safeProxyFactory,
      abi: SAFE_PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args: [safeSingleton, initializer, saltNonce],
    })

    consola.success(`Transaction submitted: ${txHash}`)
    consola.start('Waiting for transaction confirmation...')

    // Wait for transaction confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

    consola.success('Transaction confirmed!')

    // To find the Safe address, we need to look at the ProxyCreation event logs
    // Event signature: ProxyCreation(address proxy, address singleton)
    // The proxy address is in the first indexed parameter (topic1)

    // Try to find and decode the ProxyCreation event
    let safeAddress: Address | null = null

    for (const log of receipt.logs) {
      // Only check logs from the factory address
      if (log.address.toLowerCase() !== safeProxyFactory.toLowerCase()) continue

      try {
        // Try to decode this log as a ProxyCreation event
        const decodedLog = decodeEventLog({
          abi: SAFE_PROXY_FACTORY_ABI,
          data: log.data,
          topics: log.topics,
          eventName: 'ProxyCreation',
        })

        // Successfully decoded as ProxyCreation event, extract the proxy address
        safeAddress = decodedLog.args.proxy as Address
        break
      } catch (error) {
        // Not a ProxyCreation event or decoding failed, continue to next log
        continue
      }
    }

    if (safeAddress) {
      // Successfully found and decoded the ProxyCreation event

      consola.success(`New Safe created at address: ${safeAddress}`)
      consola.info(`Owner: ${account.address}`)
      consola.info(`Threshold: ${threshold}`)

      return { safeAddress }
    } else {
      consola.error(
        'Transaction confirmed but no logs found to determine Safe address.'
      )
      return { error: 'No logs found' }
    }
  } catch (error) {
    consola.error('Error creating Safe:')
    consola.error(error)
    return { error }
  }
}

// Run the script
createSafe().catch((error) => {
  consola.error('Fatal error:')
  consola.error(error)
  process.exit(1)
})
