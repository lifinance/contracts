/**
 * Deploy a Safe multisig contract using the SafeProxyFactory
 * The script combines owners from two sources:
 * 1. The global configuration (config/global.json)
 * 2. Additional owners provided via command line arguments
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
 * bun deploy-standalone-safe.ts --network arbitrum --threshold 3 --owners 0x123,0x456
 */

import { defineCommand, runMain } from 'citty'
import {
  encodeFunctionData,
  isAddress,
  parseAbi,
  getAddress,
  Address,
  zeroAddress,
  decodeEventLog,
} from 'viem'
import consola from 'consola'
import * as dotenv from 'dotenv'
import { SupportedChain } from '../../demoScripts/utils/demoScriptChainConfig'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

dotenv.config()

const SAFE_ARTIFACT = JSON.parse(
  readFileSync(
    join(__dirname, '../../../out/Safe_flattened.sol/Safe.json'),
    'utf8'
  )
)

const SAFE_PROXY_FACTORY_ARTIFACT = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../out/SafeProxyFactory_flattened.sol/SafeProxyFactory.json'
    ),
    'utf8'
  )
)

// Helper function to get chain ID (similar to your bash version)
const getChainId = (network: string): string => {
  const chainId = networks[network]?.chainId
  if (!chainId) {
    throw new Error(`Chain ID not found for network ${network}`)
  }
  return chainId.toString()
}

// Helper to get the verifier URL from foundry.toml
const getVerifierUrl = (network: string): string => {
  // Read and parse foundry.toml
  const foundryConfig = readFileSync('foundry.toml', 'utf8')
  const etherscanSection = foundryConfig.split('[etherscan]')[1]
  const networkConfig = etherscanSection
    .split(`${network} =`)[1]
    ?.split('\n')[0]

  if (!networkConfig) {
    throw new Error(
      `Network ${network} not found in foundry.toml etherscan configuration`
    )
  }

  // Extract URL from the config
  const urlMatch = networkConfig.match(/url\s*=\s*"([^"]*)"/)
  return urlMatch?.[1] || ''
}

const verifyContract = async (
  address: string,
  contractPath: string,
  contractName: string,
  constructorArgs: string,
  network: string
) => {
  try {
    // Get verifier URL from foundry.toml
    const verifierUrl = getVerifierUrl(network)
    const constructorArgsFlag =
      constructorArgs === '0x' ? '' : `--constructor-args ${constructorArgs}`

    const command = `forge verify-contract --verifier-url "${verifierUrl}" --watch ${constructorArgsFlag} ${address} ${contractPath}:${contractName}`

    consola.info(`Running verification command: ${command}`)
    execSync(command, { stdio: 'inherit' })
    return true
  } catch (error) {
    // Try Sourcify verification as fallback
    consola.info(`Trying to verify ${contractName} using Sourcify...`)
    try {
      execSync(
        `forge verify-contract ${address} ${contractName} --chain-id ${getChainId(
          network
        )} --verifier sourcify --watch`,
        { stdio: 'inherit' }
      )
      return true
    } catch (sourcifyError) {
      consola.error(
        `Failed to verify ${contractName} with both Etherscan and Sourcify:`,
        error
      )
      return false
    }
  }
}

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

      // const ownersArg = args.owners || ''
      // const ownersRaw = ownersArg
      //   .split(',')
      //   .map((o) => o.trim())
      //   .filter((o) => o.length > 0)

      // // validate owners
      // const ownersFromGlobalConfig = globalConfig.safeOwners as Address[]
      // const ownersFromArgs = ownersRaw.map((o) => {
      //   if (!isAddress(o)) {
      //     throw new Error(`Invalid address in --owners: ${o}`)
      //   }
      //   return getAddress(o)
      // })

      // const owners = [...ownersFromGlobalConfig, ...ownersFromArgs] as Address[]

      // if (owners.length === 0) {
      //   throw new Error('At least one owner address must be provided')
      // }

      // if (threshold > owners.length) {
      //   throw new Error('Threshold cannot be greater than the number of owners')
      // }

      // // optional parameters
      // const fallbackHandler =
      //   args.fallbackHandler && isAddress(args.fallbackHandler)
      //     ? getAddress(args.fallbackHandler)
      //     : zeroAddress

      // const paymentToken =
      //   args.paymentToken && isAddress(args.paymentToken)
      //     ? getAddress(args.paymentToken)
      //     : zeroAddress

      // const payment = args.payment ? BigInt(args.payment) : 0n
      // const paymentReceiver =
      //   args.paymentReceiver && isAddress(args.paymentReceiver)
      //     ? getAddress(args.paymentReceiver)
      //     : zeroAddress

      // consola.info('Network:', networkName)
      // consola.info('Owners:', owners)
      // consola.info('Threshold:', threshold)
      // consola.info('Fallback Handler:', fallbackHandler)
      // consola.info('Payment Token:', paymentToken)
      // consola.info('Payment:', payment)
      // consola.info('Payment Receiver:', paymentReceiver)

      // // First deploy the Safe implementation if not already deployed
      // consola.info('Deploying Safe implementation...')
      // const implementationHash = await walletClient.deployContract({
      //   abi: SAFE_ARTIFACT.abi,
      //   bytecode: SAFE_ARTIFACT.bytecode.object as `0x${string}`,
      //   args: [],
      // })

      // consola.info('Safe implementation deployment transaction sent. Hash:', implementationHash)

      // const implementationReceipt = await publicClient.waitForTransactionReceipt({
      //   hash: implementationHash
      // })
      // if (implementationReceipt.status === 'reverted') {
      //   throw new Error('Safe implementation deployment transaction reverted')
      // }

      // if (!implementationReceipt.contractAddress) {
      //   throw new Error('No contract address in implementation deployment receipt')
      // }

      // const implementationAddress = implementationReceipt.contractAddress
      // consola.info('Safe implementation deployed at:', implementationAddress)

      // // Deploy the SafeProxyFactory if not already deployed
      // consola.info('Deploying SafeProxyFactory...')
      // const factoryHash = await walletClient.deployContract({
      //   abi: SAFE_PROXY_FACTORY_ARTIFACT.abi,
      //   bytecode: SAFE_PROXY_FACTORY_ARTIFACT.bytecode.object as `0x${string}`,
      //   args: [],
      // })

      // consola.info('SafeProxyFactory deployment transaction sent. Hash:', factoryHash)

      // const factoryReceipt = await publicClient.waitForTransactionReceipt({
      //   hash: factoryHash
      // })
      // if (factoryReceipt.status === 'reverted') {
      //   throw new Error('SafeProxyFactory deployment transaction reverted')
      // }

      // if (!factoryReceipt.contractAddress) {
      //   throw new Error('No contract address in factory deployment receipt')
      // }

      // const factoryAddress = factoryReceipt.contractAddress
      // consola.info('SafeProxyFactory deployed at:', factoryAddress)

      // // Prepare the initializer data for the proxy
      // const initializerData = encodeFunctionData({
      //   abi: SAFE_ARTIFACT.abi,
      //   functionName: 'setup',
      //   args: [
      //     owners,
      //     BigInt(threshold),
      //     zeroAddress,
      //     '0x',
      //     fallbackHandler,
      //     paymentToken,
      //     payment,
      //     paymentReceiver,
      //   ],
      // })

      // // Create proxy using the factory
      // consola.info('Creating Safe proxy...')
      // const proxyHash = await walletClient.writeContract({
      //   address: factoryAddress,
      //   abi: SAFE_PROXY_FACTORY_ARTIFACT.abi,
      //   functionName: 'createProxyWithNonce',
      //   args: [
      //     implementationAddress,
      //     initializerData,
      //     BigInt(Date.now()), // Using timestamp as salt nonce
      //   ],
      // })

      // consola.info('Proxy creation transaction sent. Hash:', proxyHash)

      // const proxyReceipt = await publicClient.waitForTransactionReceipt({
      //   hash: proxyHash
      // })
      // if (proxyReceipt.status === 'reverted') {
      //   throw new Error('Proxy creation transaction reverted')
      // }

      // // Find the proxy address from the ProxyCreation event
      // const proxyCreationEvents = proxyReceipt.logs.map(log => {
      //   try {
      //     return decodeEventLog({
      //       abi: SAFE_PROXY_FACTORY_ARTIFACT.abi,
      //       data: log.data,
      //       topics: log.topics,
      //     })
      //   } catch {
      //     return null
      //   }
      // }).filter(event => event && event.eventName === 'ProxyCreation')

      // if (proxyCreationEvents.length === 0) {
      //   throw new Error('Could not find ProxyCreation event in receipt')
      // }

      // const safeAddress = proxyCreationEvents[0].args.proxy as Address
      // consola.info('Safe proxy deployed at:', safeAddress)

      // After successful deployment and configuration verification, verify the contracts
      consola.info('Starting contract verification...')

      const implementationAddress = '0xb82be7c20e83893bb1159f87bc412fb89f6641ae'
      const factoryAddress = '0x602482ed1f26e39723c30a01e76290e05125c2b3'
      const safeAddress = '0x6A599De7E42c5384058119B4eC577123d7B4a6dE'
      // 1. Verify Safe implementation
      consola.info('Verifying Safe implementation...')
      await verifyContract(
        implementationAddress,
        'src/Safe/Safe_flattened.sol',
        'Safe',
        '0x', // Empty constructor args
        networkName
      )

      // 2. Verify SafeProxyFactory
      consola.info('Verifying SafeProxyFactory...')
      await verifyContract(
        factoryAddress,
        'src/Safe/SafeProxyFactory_flattened.sol',
        'SafeProxyFactory',
        '$(cast abi-encode "constructor()")',
        networkName
      )

      // 3. Verify Safe Proxy
      consola.info('Verifying Safe Proxy...')
      const proxyConstructorArgs = await execSync(
        `cast abi-encode "constructor(address)" "${implementationAddress}"`
      )
        .toString()
        .trim()

      consola.info('Proxy constructor args:', proxyConstructorArgs)

      await verifyContract(
        safeAddress,
        'src/Safe/SafeProxyFactory_flattened.sol',
        'SafeProxy',
        proxyConstructorArgs,
        networkName
      )

      consola.success('All contracts verified successfully!')
    } catch (error: any) {
      consola.error('Error deploying Safe:', error.message)
      process.exit(1)
    }
  },
})

runMain(main)
