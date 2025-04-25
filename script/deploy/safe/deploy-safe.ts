/**
 * Safe Deployment Script
 *
 * This script automates the deployment of Gnosis Safe wallets on new EVM chains.
 * It creates a new Safe with owners from global.json, sets a threshold of 3,
 * and updates the networks.json configuration.
 *
 * Usage:
 *   bun script/deploy/safe/deploy-safe.ts --network <NETWORK_NAME> [--privateKey <PRIVATE_KEY>] [--rpcUrl <RPC_URL>] [--updateConfig <true|false>]
 *
 * Example:
 *   bun script/deploy/safe/deploy-safe.ts --network avalanche
 */

import {
  Address,
  Chain,
  Hex,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseEventLogs,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getPrivateKey } from './safe-utils'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'
import * as fs from 'fs'
import * as path from 'path'
import consola from 'consola'
import { defineCommand, runMain } from 'citty'
import * as dotenv from 'dotenv'
import {
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
  getSafeSingletonDeployment,
  getFallbackHandlerDeployment,
} from '@safe-global/safe-deployments'

dotenv.config()

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

/**
 * Deploys a new Safe using the SafeProxyFactory
 */
async function deployNewSafe({
  publicClient,
  walletClient,
  chain,
  ownerAddresses,
  threshold,
}: {
  publicClient: PublicClient
  walletClient: WalletClient
  chain: Chain
  ownerAddresses: Address[]
  threshold: number
}): Promise<Address> {
  // Safe Contracts: v1.3.0 is the stable version for most chains
  // For L2 chains, we use the L2 version of the singleton
  const isL2Chain = !!chain.contracts?.l2OutputOracle // Simple heuristic to detect L2s
  const safeVersion = 'v1.3.0' // Target version

  // Get Safe contract addresses for the target chain
  const singletonDeployment = isL2Chain
    ? getSafeL2SingletonDeployment({
        network: String(chain.id),
        version: safeVersion,
      })
    : getSafeSingletonDeployment({
        network: String(chain.id),
        version: safeVersion,
      })

  const factoryDeployment = getProxyFactoryDeployment({
    network: String(chain.id),
    version: safeVersion,
  })

  const fallbackHandlerDeployment = getFallbackHandlerDeployment({
    network: String(chain.id),
    version: safeVersion,
  })

  // Check if we need to use default mainnet contracts (for chains not yet in the package)
  let safeImplementationAddress =
    singletonDeployment?.networkAddresses[String(chain.id)]
  if (!safeImplementationAddress && singletonDeployment) {
    consola.warn(
      `No Safe singleton deployment found for chain ID ${chain.id}. Using latest version.`
    )
    // Find the latest deployment by sorting contract addresses by network ID
    const networks = Object.keys(singletonDeployment.networkAddresses).sort(
      (a, b) => parseInt(b) - parseInt(a)
    )

    if (networks.length > 0) {
      safeImplementationAddress =
        singletonDeployment.networkAddresses[networks[0]]
      consola.info(
        `Using Safe singleton from network ${networks[0]}: ${safeImplementationAddress}`
      )
    } else {
      throw new Error(
        'No Safe singleton deployment found in @safe-global/safe-deployments'
      )
    }
  }

  let factoryAddress = factoryDeployment?.networkAddresses[String(chain.id)]
  if (!factoryAddress && factoryDeployment) {
    consola.warn(
      `No Safe factory deployment found for chain ID ${chain.id}. Using latest version.`
    )
    const networks = Object.keys(factoryDeployment.networkAddresses).sort(
      (a, b) => parseInt(b) - parseInt(a)
    )

    if (networks.length > 0) {
      factoryAddress = factoryDeployment.networkAddresses[networks[0]]
      consola.info(
        `Using Safe factory from network ${networks[0]}: ${factoryAddress}`
      )
    } else {
      throw new Error(
        'No Safe factory deployment found in @safe-global/safe-deployments'
      )
    }
  }

  let fallbackHandlerAddress =
    fallbackHandlerDeployment?.networkAddresses[String(chain.id)]
  if (!fallbackHandlerAddress && fallbackHandlerDeployment) {
    consola.warn(
      `No fallback handler deployment found for chain ID ${chain.id}. Using latest version.`
    )
    const networks = Object.keys(
      fallbackHandlerDeployment.networkAddresses
    ).sort((a, b) => parseInt(b) - parseInt(a))

    if (networks.length > 0) {
      fallbackHandlerAddress =
        fallbackHandlerDeployment.networkAddresses[networks[0]]
      consola.info(
        `Using fallback handler from network ${networks[0]}: ${fallbackHandlerAddress}`
      )
    } else {
      // This is less critical, so set to zero address if not found
      fallbackHandlerAddress = '0x0000000000000000000000000000000000000000'
      consola.warn(`Using zero address for fallback handler`)
    }
  }

  if (!safeImplementationAddress || !factoryAddress) {
    throw new Error('Required Safe contract addresses not found')
  }

  consola.info(
    `Using Safe Implementation: \u001b[36m${safeImplementationAddress}\u001b[0m`
  )
  consola.info(`Using Factory: \u001b[36m${factoryAddress}\u001b[0m`)
  consola.info(
    `Using Fallback Handler: \u001b[36m${fallbackHandlerAddress}\u001b[0m`
  )
  consola.info(
    `Setting up Safe with \u001b[33m${ownerAddresses.length}\u001b[0m owners and threshold of \u001b[33m${threshold}\u001b[0m`
  )

  // Define SafeProxyFactory ABI for createProxyWithNonce
  const safeProxyFactoryAbi = [
    {
      inputs: [
        { internalType: 'address', name: '_singleton', type: 'address' },
        { internalType: 'bytes', name: 'initializer', type: 'bytes' },
        { internalType: 'uint256', name: 'saltNonce', type: 'uint256' },
      ],
      name: 'createProxyWithNonce',
      outputs: [
        { internalType: 'contract SafeProxy', name: 'proxy', type: 'address' },
      ],
      stateMutability: 'nonpayable',
      type: 'function',
    },
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          internalType: 'contract SafeProxy',
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
  ] as const

  // Safe Singleton setup function ABI
  const safeSingletonAbi = [
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
    {
      inputs: [],
      name: 'getOwners',
      outputs: [{ type: 'address[]' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'getThreshold',
      outputs: [{ type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ] as const

  // Encode initializer calldata for Safe setup
  const initializerCalldata = encodeFunctionData({
    abi: safeSingletonAbi,
    functionName: 'setup',
    args: [
      ownerAddresses, // owners
      BigInt(threshold), // threshold
      '0x0000000000000000000000000000000000000000' as Address, // to (Optional destination address for setup transaction)
      '0x' as Hex, // data (Optional data for setup transaction)
      fallbackHandlerAddress as Address, // fallbackHandler
      '0x0000000000000000000000000000000000000000' as Address, // paymentToken (0x0 for ETH)
      0n, // payment (0 for no payment)
      '0x0000000000000000000000000000000000000000' as Address, // paymentReceiver
    ],
  })

  // Use a random salt nonce for deploying the proxy
  const saltNonce = BigInt(Math.floor(Math.random() * 1000000000))

  consola.info(
    `Deploying Safe proxy with salt nonce: \u001b[33m${saltNonce}\u001b[0m`
  )

  // Send the transaction to deploy the Safe proxy
  const hash = await walletClient.writeContract({
    address: factoryAddress as Address,
    abi: safeProxyFactoryAbi,
    functionName: 'createProxyWithNonce',
    args: [
      safeImplementationAddress as Address,
      initializerCalldata,
      saltNonce,
    ],
    chain,
  })

  consola.info(`Transaction submitted: \u001b[36m${hash}\u001b[0m`)
  consola.info(`Waiting for transaction confirmation...`)

  // Wait for the transaction to be mined with 5 confirmations
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 5,
  })

  if (receipt.status !== 'success') {
    throw new Error(`Transaction failed: ${hash}`)
  }

  consola.success(
    `Transaction confirmed in block ${receipt.blockNumber} with 5 confirmations`
  )

  // Parse the logs using viem's parseEventLogs
  const events = parseEventLogs({
    abi: safeProxyFactoryAbi,
    eventName: 'ProxyCreation',
    logs: receipt.logs,
  })

  // Check if we found any ProxyCreation events
  if (events.length === 0) {
    consola.warn('No ProxyCreation events found in transaction logs')

    // Ask the user to check the block explorer and enter the Safe address manually
    consola.info(
      `Please check transaction ${hash} on the explorer to find the deployed Safe address.`
    )
    const explorerUrl = chain.blockExplorers?.default?.url

    if (explorerUrl) {
      consola.info(`Explorer URL: ${explorerUrl}/tx/${hash}`)
    }

    // Ask for the address
    const safeAddress = (await consola.prompt(
      'Enter the deployed Safe address:',
      {
        type: 'text',
        validate: (input) =>
          /^0x[a-fA-F0-9]{40}$/.test(input)
            ? true
            : 'Please enter a valid Ethereum address',
      }
    )) as Address

    consola.info(
      `Using manually entered Safe address: \u001b[32m${safeAddress}\u001b[0m`
    )
    return safeAddress
  }

  // Found ProxyCreation event(s)
  const safeAddress = events[0].args.proxy as Address
  consola.success(
    `Safe proxy deployed at address: \u001b[32m${safeAddress}\u001b[0m`
  )

  // Verify the setup was successful
  consola.info('-'.repeat(80))
  consola.info(
    `Verifying Safe setup at address: \u001b[32m${safeAddress}\u001b[0m`
  )

  // Get owners and threshold from the deployed Safe
  const [actualOwners, actualThreshold] = await Promise.all([
    publicClient.readContract({
      address: safeAddress,
      abi: safeSingletonAbi,
      functionName: 'getOwners',
    }),
    publicClient.readContract({
      address: safeAddress,
      abi: safeSingletonAbi,
      functionName: 'getThreshold',
    }),
  ])

  // Verify owners
  const expectedOwnersLowercase = ownerAddresses.map((addr) =>
    addr.toLowerCase()
  )
  const actualOwnersLowercase = actualOwners.map((addr) => addr.toLowerCase())

  // Log the actual owners we found
  consola.info('Verifying owner addresses:')
  for (const owner of actualOwners) {
    const isExpected = expectedOwnersLowercase.includes(owner.toLowerCase())
    consola.info(`- ${owner} ${isExpected ? '✅' : '❌'}`)
  }

  // Check that all expected owners are in the actual owners list
  const allOwnersPresent = expectedOwnersLowercase.every((owner) =>
    actualOwnersLowercase.includes(owner)
  )

  // Check if there are unexpected owners
  const unexpectedOwners = actualOwnersLowercase.filter(
    (owner) => !expectedOwnersLowercase.includes(owner)
  )

  if (unexpectedOwners.length > 0) {
    consola.warn('Unexpected owners found:')
    for (const owner of unexpectedOwners) {
      consola.warn(`- ${owner}`)
    }
  }

  if (!allOwnersPresent) {
    consola.error('Owner verification failed!')
    consola.error(
      `Missing owners: ${expectedOwnersLowercase
        .filter((owner) => !actualOwnersLowercase.includes(owner))
        .join(', ')}`
    )

    const continueAnyway = await consola.prompt(
      'Safe ownership verification failed. Continue anyway?',
      {
        type: 'confirm',
        default: false,
      }
    )

    if (!continueAnyway) {
      throw new Error(
        'Safe setup verification failed: Owner addresses do not match'
      )
    }

    consola.warn('⚠️ Continuing with mismatched owners (not recommended)')
  }

  // Verify threshold
  consola.info(
    `Verifying threshold: Expected=${threshold}, Actual=${actualThreshold}`
  )

  if (actualThreshold !== BigInt(threshold)) {
    consola.error(
      `Threshold verification failed. Expected: ${threshold}, Actual: ${actualThreshold}`
    )

    const continueAnyway = await consola.prompt(
      'Safe threshold verification failed. Continue anyway?',
      {
        type: 'confirm',
        default: false,
      }
    )

    if (!continueAnyway) {
      throw new Error(
        `Safe setup verification failed: Threshold does not match. Expected: ${threshold}, Actual: ${actualThreshold}`
      )
    }

    consola.warn('⚠️ Continuing with incorrect threshold (not recommended)')
  }

  consola.success(`Safe setup verified successfully:`)
  consola.success(
    `- Owners: \u001b[33m${actualOwners.length}\u001b[0m addresses configured`
  )
  consola.success(
    `- Threshold: \u001b[33m${actualThreshold}\u001b[0m signatures required`
  )

  return safeAddress
}

/**
 * Main function to deploy a Safe on a specific chain
 */
async function deploySafe(args: {
  network: string
  privateKey?: string
  rpcUrl?: string
  updateConfig?: boolean
}) {
  try {
    // Destructure arguments with defaults
    const { network, rpcUrl, updateConfig = true } = args

    // Get private key
    const privateKey = getPrivateKey(args.privateKey, 'PRIVATE_KEY_PRODUCTION')

    // Load configuration files
    const globalConfigPath = path.resolve('./config/global.json')
    const networksConfigPath = path.resolve('./config/networks.json')

    if (!fs.existsSync(globalConfigPath)) {
      throw new Error(`Global config file not found at ${globalConfigPath}`)
    }
    if (!fs.existsSync(networksConfigPath)) {
      throw new Error(`Networks config file not found at ${networksConfigPath}`)
    }

    const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'))
    const networksConfig = JSON.parse(
      fs.readFileSync(networksConfigPath, 'utf8')
    )

    // Validate network exists in networks.json
    if (!networksConfig[network.toLowerCase()]) {
      throw new Error(`Network "${network}" not found in networks.json`)
    }

    // Check if Safe already exists for this network
    if (networksConfig[network.toLowerCase()].safeAddress) {
      consola.warn(
        `Safe already exists for network ${network}: ${
          networksConfig[network.toLowerCase()].safeAddress
        }`
      )

      // Ask user if they want to overwrite the existing Safe address
      const shouldOverwrite = await consola.prompt(
        `Do you want to deploy a new Safe and overwrite the existing address for ${network}?`,
        {
          type: 'confirm',
          default: false,
        }
      )

      if (!shouldOverwrite) {
        consola.info(
          'Deployment cancelled. Existing Safe address will be kept.'
        )
        process.exit(0)
      }

      consola.warn(
        '⚠️ Proceeding with deployment - the existing Safe address will be overwritten in networks.json'
      )
    }

    // Get owner addresses from global.json
    const ownerAddresses = globalConfig.safeOwners as string[]
    if (!ownerAddresses || ownerAddresses.length === 0) {
      throw new Error('No Safe owners found in config/global.json')
    }

    consola.info('-'.repeat(80))
    consola.info(`🔐 Deploying new Safe Wallet on ${network.toUpperCase()}`)
    consola.info('-'.repeat(80))

    // Initialize Viem clients
    const chain = getViemChainForNetworkName(network)
    const customRpcUrl = rpcUrl || chain.rpcUrls.default.http[0]

    const account = privateKeyToAccount(`0x${privateKey}` as Hex)

    const publicClient = createPublicClient({
      chain,
      transport: http(customRpcUrl),
    })

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(customRpcUrl),
    })

    consola.info(
      `Network: \u001b[33m${network} (Chain ID: ${chain.id})\u001b[0m`
    )
    consola.info(`Deployer address: \u001b[32m${account.address}\u001b[0m`)
    consola.info(`RPC URL: ${customRpcUrl}`)
    consola.info('-'.repeat(80))

    // Deploy the Safe
    const safeAddress = await deployNewSafe({
      publicClient,
      walletClient,
      chain,
      ownerAddresses: ownerAddresses as Address[],
      threshold: 3,
    })

    if (!safeAddress) {
      throw new Error('Safe deployment failed')
    }

    consola.success(
      `✅ Safe successfully deployed at \u001b[32m${safeAddress}\u001b[0m`
    )

    // Update networks.json if enabled
    if (updateConfig) {
      // Determine Safe Web URL based on chain
      let safeWebUrl = ''
      if (chain.id === 1) {
        // Ethereum Mainnet
        safeWebUrl = `https://app.safe.global/home?safe=eth:${safeAddress}`
      } else {
        // Other chains, use network-specific format
        const networkKey = network.toLowerCase()
        let chainShortName = networkKey

        // Map to Safe's standard chain names if needed
        const safeChainNameMap: Record<string, string> = {
          arbitrum: 'arb1',
          optimism: 'oeth',
          polygon: 'matic',
          bsc: 'bnb',
          // Add more mappings as needed
        }

        if (safeChainNameMap[networkKey]) {
          chainShortName = safeChainNameMap[networkKey]
        }

        safeWebUrl = `https://app.safe.global/home?safe=${chainShortName}:${safeAddress}`
      }

      // Update configurations
      const updatedNetworksConfig = { ...networksConfig }
      updatedNetworksConfig[network.toLowerCase()].safeAddress = safeAddress
      updatedNetworksConfig[network.toLowerCase()].safeWebUrl = safeWebUrl

      // Create backup of networks.json
      const backupPath = `${networksConfigPath}.backup-${Date.now()}`
      fs.copyFileSync(networksConfigPath, backupPath)
      consola.info(`Created backup of networks.json at ${backupPath}`)

      // Write updated config
      fs.writeFileSync(
        networksConfigPath,
        JSON.stringify(updatedNetworksConfig, null, 2),
        'utf8'
      )
      consola.success(`Updated networks.json with new Safe address`)
      consola.success(`Safe Web URL: \u001b[36m${safeWebUrl}\u001b[0m`)
    }

    consola.info('-'.repeat(80))
    consola.success(`🎉 Safe deployment completed successfully`)
    consola.info(`Safe Address: \u001b[32m${safeAddress}\u001b[0m`)
    consola.info(
      `Explorer URL: \u001b[36m${chain.blockExplorers?.default?.url}/address/${safeAddress}\u001b[0m`
    )
    consola.info('-'.repeat(80))

    return safeAddress
  } catch (error) {
    consola.error(`Error deploying Safe: ${error.message}`)
    process.exit(1)
  }
}

/**
 * Command definition using citty
 */
const main = defineCommand({
  meta: {
    name: 'deploy-safe',
    description: 'Deploy a new Gnosis Safe on an EVM chain',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name to deploy the Safe on',
      required: true,
    },
    privateKey: {
      type: 'string',
      description:
        'Private key of the deployer wallet (optional, can use PRIVATE_KEY_PRODUCTION from .env)',
      required: false,
    },
    rpcUrl: {
      type: 'string',
      description:
        'Custom RPC URL (optional, uses network default if not provided)',
      required: false,
    },
    updateConfig: {
      type: 'boolean',
      description:
        'Whether to update networks.json with the new Safe address (default: true)',
      default: true,
    },
  },
  async run({ args }) {
    // If no private key provided, ask if we should use the one from .env
    const privateKey = args.privateKey
    if (!privateKey) {
      const useEnvKey = await consola.prompt(
        'No private key provided. Use PRIVATE_KEY_PRODUCTION from .env?',
        {
          type: 'confirm',
        }
      )

      if (!useEnvKey) {
        consola.warn('Deployment cancelled - no private key provided')
        process.exit(0)
      }
    }

    return deploySafe({
      network: args.network,
      privateKey,
      rpcUrl: args.rpcUrl,
      updateConfig: args.updateConfig,
    })
  },
})

runMain(main)
