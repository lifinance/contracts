/**
 * Deploy a Safe multisig contract using the SafeProxyFactory
 * The script combines owners from two sources:
 * 1. The global configuration (config/global.json)
 * 2. Additional owners provided via command line arguments
 *
 * Note: This deployment uses hardcoded bytecode and ABI of Safe contracts v1.4.1
 * and deploys them directly without relying on external files.
 * This approach enables rapid deployments on new chains
 * without waiting for official Safe contract deployments.
 * Bytecodes come from the Safe contract v1.4.1 which are store in the safe/ directory
 *
 * The script maintains deployment state in networks.json:
 * - Prevents duplicate deployments by checking existing Safe addresses
 * - Automatically updates the Safe address after successful deployment
 *
 * Required Parameters:
 * - network: The target network name (e.g., arbitrum)
 * - threshold: Number of signatures required for transactions
 *
 * Optional Parameters:
 * - owners: Comma-separated list of additional owner addresses
 * - fallbackHandler: Address of the fallback handler contract
 * - paymentToken: Address of the payment token (default: 0x0 for ETH)
 * - payment: Payment amount in wei (default: 0)
 * - paymentReceiver: Address to receive payments (default: 0x0)
 *
 * Environment Variables:
 * - PRIVATE_KEY: Deployer's private key
 * - ETH_NODE_URI_{NETWORK}: RPC URL for the target network (must be configured in .env)
 *
 * Example Usage:
 * bun deploy-and-setup.ts --network arbitrum --threshold 3
 */

import { defineCommand, runMain } from 'citty'
import {
  encodeFunctionData,
  isAddress,
  getAddress,
  Address,
  zeroAddress,
  decodeEventLog,
} from 'viem'
import * as dotenv from 'dotenv'
import { SupportedChain } from '../../demoScripts/utils/demoScriptChainConfig'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { consola } from 'consola'

dotenv.config()

const SAFE_ABI = [
  {
    inputs: [
      {
        internalType: 'address[]',
        name: '_owners',
        type: 'address[]',
      },
      {
        internalType: 'uint256',
        name: '_threshold',
        type: 'uint256',
      },
      {
        internalType: 'address',
        name: 'to',
        type: 'address',
      },
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
      {
        internalType: 'address',
        name: 'fallbackHandler',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'paymentToken',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'payment',
        type: 'uint256',
      },
      {
        internalType: 'address payable',
        name: 'paymentReceiver',
        type: 'address',
      },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const SAFE_PROXY_FACTORY_ABI = [
  {
    inputs: [
      {
        internalType: 'address',
        name: '_singleton',
        type: 'address',
      },
      {
        internalType: 'bytes',
        name: 'initializer',
        type: 'bytes',
      },
      {
        internalType: 'uint256',
        name: 'saltNonce',
        type: 'uint256',
      },
    ],
    name: 'createProxyWithNonce',
    outputs: [
      {
        internalType: 'address',
        name: 'proxy',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'proxy',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'singleton',
        type: 'address',
      },
    ],
    name: 'ProxyCreation',
    type: 'event',
  },
  // Add other methods as needed
] as const

// Helper function to compare bytecodes
const compareDeployedBytecode = async (
  publicClient: any,
  address: Address,
  expectedBytecode: `0x${string}`,
  contractName: string
): Promise<boolean> => {
  try {
    const deployedBytecode = await publicClient.getCode({ address })

    // Skip metadata hash when comparing bytecodes (last 53 bytes)
    // This is important because the same source code compiled at different times
    // can have different metadata hashes
    const deployedBytecodeWithoutMetadata = deployedBytecode.slice(0, -106)
    const expectedBytecodeWithoutMetadata = expectedBytecode.slice(0, -106)

    const bytecodeMatches =
      deployedBytecodeWithoutMetadata === expectedBytecodeWithoutMetadata

    if (bytecodeMatches) {
      consola.success(`${contractName} bytecode verified successfully`)
    } else {
      consola.error(`${contractName} bytecode verification failed`)
      consola.debug(
        `Expected: ${expectedBytecodeWithoutMetadata.slice(0, 100)}...`
      )
      consola.debug(
        `Deployed: ${deployedBytecodeWithoutMetadata.slice(0, 100)}...`
      )
    }

    return bytecodeMatches
  } catch (error) {
    consola.error(`Error verifying ${contractName} bytecode:`, error)
    return false
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const main = defineCommand({
  meta: {
    name: 'deploy-standalone-safe',
    description: 'Deploys a standalone Safe multisig contract',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name (e.g., arbitrum)',
      required: true,
    },
    threshold: {
      type: 'string',
      description: 'Safe threshold (number of signatures required)',
      required: true,
    },
    owners: {
      type: 'string',
      description:
        'Comma-separated list of additional owner addresses (e.g. 0xabc,0xdef). These will be combined with owners from global.json',
      required: false,
    },
    fallbackHandler: {
      type: 'string',
      description: 'Fallback handler address (optional)',
      required: false,
    },
    paymentToken: {
      type: 'string',
      description: 'Payment token address (default: 0x0 for ETH)',
      required: false,
    },
    payment: {
      type: 'string',
      description: 'Payment amount in wei (default: 0)',
      required: false,
    },
    paymentReceiver: {
      type: 'string',
      description: 'Payment receiver address (default: 0x0)',
      required: false,
    },
  },
  async run({ args }) {
    try {
      // Add environment selection prompt with key information
      const environment = (await consola.prompt(
        'Which environment do you want to deploy to?',
        {
          type: 'select',
          options: [
            { value: 'staging', label: 'staging (uses PRIVATE_KEY from .env)' },
            {
              value: 'production',
              label: 'production (uses PRIVATE_KEY_PRODUCTION from .env)',
            },
          ],
        }
      )) as 'staging' | 'production'

      const networkName = args.network as SupportedChain

      // Check if Safe address already exists for the network
      const existingSafeAddress = networks[networkName]?.safeAddress
      if (existingSafeAddress && existingSafeAddress !== zeroAddress) {
        throw new Error(
          `Safe contract already deployed for network ${networkName} at address ${existingSafeAddress}. Please remove or update the safeAddress in networks.json if you want to deploy a new Safe.`
        )
      }

      // Load the Safe contract artifacts that are flattened and were pre-compiled
      const SAFE_ARTIFACT = JSON.parse(
        readFileSync(
          join(__dirname, '../../../safe/out/Safe_flattened.sol/Safe.json'),
          'utf8'
        )
      )

      const SAFE_BYTECODE = SAFE_ARTIFACT.bytecode.object as `0x${string}`
      const SAFE_DEPLOYED_BYTECODE = SAFE_ARTIFACT.deployedBytecode
        .object as `0x${string}`

      const SAFE_PROXY_FACTORY_ARTIFACT = JSON.parse(
        readFileSync(
          join(
            __dirname,
            '../../../safe/out/SafeProxyFactory_flattened.sol/SafeProxyFactory.json'
          ),
          'utf8'
        )
      )

      const SAFE_PROXY_FACTORY_BYTECODE = SAFE_PROXY_FACTORY_ARTIFACT.bytecode
        .object as `0x${string}`
      const SAFE_PROXY_FACTORY_DEPLOYED_BYTECODE = SAFE_PROXY_FACTORY_ARTIFACT
        .deployedBytecode.object as `0x${string}`

      const SAFE_PROXY_ARTIFACT = JSON.parse(
        readFileSync(
          join(
            __dirname,
            '../../../safe/out/SafeProxyFactory_flattened.sol/SafeProxy.json'
          ),
          'utf8'
        )
      )

      const SAFE_PROXY_DEPLOYED_BYTECODE = SAFE_PROXY_ARTIFACT.deployedBytecode
        .object as `0x${string}`

      let threshold: number
      if (typeof args.threshold === 'number') {
        threshold = args.threshold
      } else {
        threshold = Number(args.threshold)
        if (isNaN(threshold)) {
          throw new Error('Invalid threshold value: must be a number')
        }
      }
      if (threshold < 1) {
        throw new Error('Threshold must be at least 1')
      }

      const { walletAccount, publicClient, walletClient } =
        await setupEnvironment(networkName, null, environment)

      consola.info('Environment:', environment)
      consola.info('Deployer (signer) address:', walletAccount.address)

      const ownersArg = args.owners || ''
      const ownersRaw = ownersArg
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)

      // validate owners
      const ownersFromGlobalConfig = globalConfig.safeOwners as Address[]
      const ownersFromArgs = ownersRaw.map((o) => {
        if (!isAddress(o)) {
          throw new Error(`Invalid address in --owners: ${o}`)
        }
        return getAddress(o)
      })

      const owners = [...ownersFromGlobalConfig, ...ownersFromArgs] as Address[]

      if (owners.length === 0) {
        throw new Error('At least one owner address must be provided')
      }

      if (threshold > owners.length) {
        throw new Error('Threshold cannot be greater than the number of owners')
      }

      // optional parameters
      const fallbackHandler =
        args.fallbackHandler && isAddress(args.fallbackHandler)
          ? getAddress(args.fallbackHandler)
          : zeroAddress

      const paymentToken =
        args.paymentToken && isAddress(args.paymentToken)
          ? getAddress(args.paymentToken)
          : zeroAddress

      const payment = args.payment ? BigInt(args.payment) : 0n
      const paymentReceiver =
        args.paymentReceiver && isAddress(args.paymentReceiver)
          ? getAddress(args.paymentReceiver)
          : zeroAddress

      // Validate fallbackHandler is a deployed contract
      if (fallbackHandler !== zeroAddress) {
        const code = await publicClient.getCode({ address: fallbackHandler })
        if (!code || code === '0x') {
          consola.warn(
            'Warning: fallbackHandler has no contract code—fallback calls will fail.'
          )
          const proceed = await consola.prompt(
            'fallbackHandler is not a contract. Proceed anyway?',
            { type: 'confirm', initial: false }
          )
          if (!proceed) throw new Error('Deployment cancelled by user')
        }
      }

      consola.info('Network:', networkName)
      consola.info('Owners:', owners)
      consola.info('Threshold:', threshold)
      consola.info('Fallback Handler:', fallbackHandler)
      consola.info('Payment Token:', paymentToken)
      consola.info('Payment:', payment)
      consola.info('Payment Receiver:', paymentReceiver)

      // First deploy the Safe implementation if not already deployed
      consola.info('Deploying Safe implementation...')
      const implementationHash = await walletClient.deployContract({
        abi: SAFE_ABI,
        bytecode: SAFE_BYTECODE,
        args: [],
      })

      consola.info(
        'Safe implementation deployment transaction sent. Hash:',
        implementationHash
      )

      const implementationReceipt =
        await publicClient.waitForTransactionReceipt({
          hash: implementationHash,
        })
      if (implementationReceipt.status === 'reverted') {
        throw new Error('Safe implementation deployment transaction reverted')
      }

      if (!implementationReceipt.contractAddress) {
        throw new Error(
          'No contract address in implementation deployment receipt'
        )
      }

      const implementationAddress = implementationReceipt.contractAddress
      consola.info('Safe implementation deployed at:', implementationAddress)

      await sleep(5000)

      // Verify implementation bytecode immediately
      const implementationVerified = await compareDeployedBytecode(
        publicClient,
        implementationAddress,
        SAFE_DEPLOYED_BYTECODE,
        'Safe Implementation'
      )

      if (!implementationVerified) {
        throw new Error('Safe implementation bytecode verification failed')
      }

      // Deploy the SafeProxyFactory if not already deployed
      consola.info('Deploying SafeProxyFactory...')
      const factoryHash = await walletClient.deployContract({
        abi: SAFE_PROXY_FACTORY_ABI,
        bytecode: SAFE_PROXY_FACTORY_BYTECODE,
        args: [],
      })

      consola.info(
        'SafeProxyFactory deployment transaction sent. Hash:',
        factoryHash
      )

      const factoryReceipt = await publicClient.waitForTransactionReceipt({
        hash: factoryHash,
      })
      if (factoryReceipt.status === 'reverted') {
        throw new Error('SafeProxyFactory deployment transaction reverted')
      }

      if (!factoryReceipt.contractAddress) {
        throw new Error('No contract address in factory deployment receipt')
      }

      const factoryAddress = factoryReceipt.contractAddress
      consola.info('SafeProxyFactory deployed at:', factoryAddress)

      await sleep(5000)

      // Verify factory bytecode immediately
      const factoryVerified = await compareDeployedBytecode(
        publicClient,
        factoryAddress,
        SAFE_PROXY_FACTORY_DEPLOYED_BYTECODE,
        'SafeProxyFactory'
      )

      if (!factoryVerified) {
        throw new Error('SafeProxyFactory bytecode verification failed')
      }

      // Prepare the initializer data for the proxy
      const initializerData = encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'setup',
        args: [
          owners,
          BigInt(threshold),
          zeroAddress,
          '0x',
          fallbackHandler,
          paymentToken,
          payment,
          paymentReceiver,
        ],
      })

      // Create proxy using the factory
      consola.info('Creating Safe proxy...')
      const proxyHash = await walletClient.writeContract({
        address: factoryAddress,
        abi: SAFE_PROXY_FACTORY_ABI,
        functionName: 'createProxyWithNonce',
        args: [
          implementationAddress,
          initializerData,
          // Combine timestamp with deployer address to make nonce unique per deployer
          BigInt(Date.now()) ^
            BigInt.asUintN(64, BigInt(walletAccount.address)),
        ],
      })

      consola.info('Proxy creation transaction sent. Hash:', proxyHash)

      const proxyReceipt = await publicClient.waitForTransactionReceipt({
        hash: proxyHash,
      })
      if (proxyReceipt.status === 'reverted') {
        throw new Error('Proxy creation transaction reverted')
      }

      // Find the proxy address from the ProxyCreation event
      const proxyCreationEvents = proxyReceipt.logs
        .map((log) => {
          try {
            return decodeEventLog({
              abi: SAFE_PROXY_FACTORY_ABI,
              data: log.data,
              topics: log.topics,
            }) as { eventName: string; args: { proxy: Address } } | null
          } catch {
            return null
          }
        })
        .filter(
          (event): event is { eventName: string; args: { proxy: Address } } =>
            event !== null &&
            'eventName' in event &&
            event.eventName === 'ProxyCreation'
        )

      if (proxyCreationEvents.length === 0) {
        throw new Error('Could not find ProxyCreation event in receipt')
      }

      const safeAddress = proxyCreationEvents[0].args.proxy as Address
      consola.info('Safe proxy deployed at:', safeAddress)

      await sleep(5000)

      // Verify factory bytecode immediately
      const safeProxyVerified = await compareDeployedBytecode(
        publicClient,
        safeAddress,
        SAFE_PROXY_DEPLOYED_BYTECODE,
        'SafeProxy'
      )

      if (!safeProxyVerified) {
        throw new Error('SafeProxyFactory bytecode verification failed')
      }

      // After successful deployment and verification, update networks.json
      consola.info('Updating networks.json with the new Safe address...')

      // Update the networks configuration
      networks[networkName] = {
        ...networks[networkName],
        safeAddress: safeAddress,
      }

      // Write back to networks.json
      writeFileSync(
        join(__dirname, '../../../config/networks.json'),
        JSON.stringify(networks, null, 2),
        'utf8'
      )

      consola.success(
        'Successfully updated networks.json with the new Safe address!'
      )
      consola.info('')
      consola.info(
        'IMPORTANT: Please manually update the safeWebUrl and safeApiUrl in networks.json for proper Safe UI integration.'
      )
    } catch (error: any) {
      consola.error('Error deploying Safe:', error.message)
      process.exit(1)
    }
  },
})

runMain(main)
