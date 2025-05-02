/**
 * Deploy and Setup a new multisig Safe
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
 * - safeSingleton: Address of the Gnosis Safe singleton contract (optional - will be fetched from safe-deployments)
 * - proxyFactory: Address of the Gnosis Safe Proxy Factory contract (optional - will be fetched from safe-deployments)
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
 * bun deploy-and-setup-safe.ts --network arbitrum --threshold 3 --owners 0x123,0x456
 *
 * The script will:
 * 1. Verify the provided or fetched Safe contract addresses
 * 2. Deploy a new Safe proxy
 * 3. Initialize it with the specified owners and threshold
 * 4. Verify the final configuration
 */

import { defineCommand, runMain } from 'citty'
import {
  encodeFunctionData,
  isAddress,
  parseAbi,
  getAddress,
  Address,
  zeroAddress,
} from 'viem'
import consola from 'consola'
import * as dotenv from 'dotenv'
import {
  getSafeSingletonDeployment,
  getProxyFactoryDeployment,
} from '@safe-global/safe-deployments'
import { SupportedChain } from '../../demoScripts/utils/demoScriptChainConfig'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { readFileSync } from 'fs'
import { join } from 'path'

dotenv.config()

const SAFE_ARTIFACT = JSON.parse(
  readFileSync(
    join(__dirname, '../../../out/Safe_flattened.sol/Safe.json'),
    'utf8'
  )
)

const GNOSIS_SAFE_PROXY_FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
])

const GNOSIS_SAFE_ABI = parseAbi([
  // setup(
  //   address[] calldata _owners,
  //   uint256 _threshold,
  //   address to,
  //   bytes calldata data,
  //   address fallbackHandler,
  //   address paymentToken,
  //   uint256 payment,
  //   address payable paymentReceiver
  // ) external
  'function setup(address[],uint256,address,bytes,address,address,uint256,address) external',
])

const main = defineCommand({
  meta: {
    name: 'deploy-and-setup-safe',
    description:
      'Deploys a new Gnosis Safe proxy and calls setup(...) in staging or production environment',
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
    safeSingleton: {
      type: 'string',
      description:
        'Address of the Gnosis Safe singleton contract (optional - will be fetched from safe-deployments package if not provided)',
      required: false,
    },
    proxyFactory: {
      type: 'string',
      description:
        'Address of the Gnosis Safe Proxy Factory contract (optional - will be fetched from safe-deployments package if not provided)',
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

      // Get Safe contract addresses from safe-deployments if not provided
      const chainId = networks[networkName]?.chainId
      if (!chainId) {
        throw new Error(`Chain ID not found for network ${networkName}`)
      }

      let safeSingleton: Address | undefined
      let proxyFactory: Address | undefined

      // First check if addresses were provided as parameters
      if (args.safeSingleton && args.proxyFactory) {
        safeSingleton = getAddress(args.safeSingleton)
        proxyFactory = getAddress(args.proxyFactory)
        consola.info('Using provided Safe addresses:')

        // Try to verify against safe-deployments
        const safeSingletonDeployment = getSafeSingletonDeployment({
          network: chainId.toString(),
        })
        const proxyFactoryDeployment = getProxyFactoryDeployment({
          network: chainId.toString(),
        })

        if (safeSingletonDeployment && proxyFactoryDeployment) {
          const safeSingletonFromDeployment =
            safeSingletonDeployment.networkAddresses[chainId.toString()]
          const proxyFactoryFromDeployment =
            proxyFactoryDeployment.networkAddresses[chainId.toString()]

          if (safeSingletonFromDeployment && proxyFactoryFromDeployment) {
            if (
              safeSingleton.toLowerCase() !==
                safeSingletonFromDeployment.toLowerCase() ||
              proxyFactory.toLowerCase() !==
                proxyFactoryFromDeployment.toLowerCase()
            ) {
              consola.warn(
                'Provided addresses differ from safe-deployments package:'
              )
              consola.warn(
                `Safe Singleton: provided=${safeSingleton}, safe-deployments=${safeSingletonFromDeployment}`
              )
              consola.warn(
                `Proxy Factory: provided=${proxyFactory}, safe-deployments=${proxyFactoryFromDeployment}`
              )
            } else {
              consola.success(
                'Provided addresses match safe-deployments package'
              )
            }
          }
        } else {
          consola.warn(
            'Could not verify provided addresses against safe-deployments package (no deployment data available)'
          )
        }
      } else {
        // No addresses provided, try to get from safe-deployments
        const safeSingletonDeployment = getSafeSingletonDeployment({
          network: chainId.toString(),
        })
        const proxyFactoryDeployment = getProxyFactoryDeployment({
          network: chainId.toString(),
        })

        if (safeSingletonDeployment && proxyFactoryDeployment) {
          const safeSingletonFromDeployment =
            safeSingletonDeployment.networkAddresses[chainId.toString()]
          const proxyFactoryFromDeployment =
            proxyFactoryDeployment.networkAddresses[chainId.toString()]

          if (safeSingletonFromDeployment && proxyFactoryFromDeployment) {
            safeSingleton = getAddress(safeSingletonFromDeployment)
            proxyFactory = getAddress(proxyFactoryFromDeployment)
            consola.info('Using Safe addresses from safe-deployments package:')
          } else {
            throw new Error(
              `Could not find Safe contract addresses for chain ID ${chainId} in safe-deployments package.\n` +
                'Please provide safeSingleton and proxyFactory addresses manually.'
            )
          }
        } else {
          throw new Error(
            `Could not find Safe deployments for chain ID ${chainId} in safe-deployments package.\n` +
              'Please provide safeSingleton and proxyFactory addresses manually.'
          )
        }
      }

      consola.info('Safe Singleton:', safeSingleton)
      consola.info('Proxy Factory:', proxyFactory)

      const { walletAccount, publicClient, walletClient } =
        await setupEnvironment(networkName, null, environment)

      consola.info('Environment:', environment)
      consola.info('Deployer (signer) address:', walletAccount.address)

      // Verify the contracts exist and are valid
      try {
        const safeSingletonCode = await publicClient.getCode({
          address: safeSingleton,
        })
        if (!safeSingletonCode || safeSingletonCode === '0x') {
          throw new Error(
            `Safe Singleton contract not found at ${safeSingleton}`
          )
        }

        const proxyFactoryCode = await publicClient.getCode({
          address: proxyFactory,
        })
        if (!proxyFactoryCode || proxyFactoryCode === '0x') {
          throw new Error(`Proxy Factory contract not found at ${proxyFactory}`)
        }
      } catch (error) {
        consola.error('Error verifying Safe contracts:', error)
        throw new Error(
          'Failed to verify Safe contract addresses. Please check the addresses are correct for this network.'
        )
      }

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

      consola.info('Network:', networkName)
      consola.info('Master Copy:', safeSingleton)
      consola.info('Proxy Factory:', proxyFactory)
      consola.info('Owners:', owners)
      consola.info('Threshold:', threshold)
      consola.info('Fallback Handler:', fallbackHandler)
      consola.info('Payment Token:', paymentToken)
      consola.info('Payment:', payment)
      consola.info('Payment Receiver:', paymentReceiver)

      // Deploy using proxy factory
      const setupData = encodeFunctionData({
        abi: SAFE_ARTIFACT.abi,
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

      const gasEstimate = await publicClient.estimateGas({
        account: walletAccount.address,
        to: proxyFactory,
        data: encodeFunctionData({
          abi: GNOSIS_SAFE_PROXY_FACTORY_ABI,
          functionName: 'createProxyWithNonce',
          args: [safeSingleton, setupData, BigInt(Date.now())],
        }),
      })

      const hash = await walletClient.writeContract({
        address: proxyFactory,
        abi: GNOSIS_SAFE_PROXY_FACTORY_ABI,
        functionName: 'createProxyWithNonce',
        args: [
          safeSingleton,
          setupData,
          BigInt(Date.now()), // salt nonce
        ],
        gas: gasEstimate + 100_000n, // Add buffer to gas estimate
      })

      consola.info('Transaction sent. Hash:', hash)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status === 'reverted') {
        // Try to get the revert reason
        try {
          const tx = await publicClient.getTransaction({ hash })
          const result = await publicClient.call({
            account: walletAccount.address,
            to: proxyFactory,
            data: tx.input,
          })
          throw new Error(`Transaction reverted: ${result}`)
        } catch (error) {
          throw new Error(
            'Transaction reverted for an unknown reason. Please check the Safe contract addresses and parameters.'
          )
        }
      }
      consola.info('Transaction confirmed in block', receipt.blockNumber)

      // retrieve the new proxy address from logs
      let newSafeAddress: Address | undefined
      if (receipt.logs) {
        for (const log of receipt.logs) {
          const proxyCreationTopic =
            '0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235'
          if (log.address.toLowerCase() === proxyFactory.toLowerCase()) {
            // - topic[0] = keccak256(ProxyCreation) - topic
            // data contains proxy contract address as a first address param
            if (log && log.topics[0] === proxyCreationTopic && log.topics[1]) {
              // Assuming the proxy address is the first indexed parameter,
              // it should be in topics[1]. Extract the last 40 characters.
              const rawProxyAddress = '0x' + log.topics[1].slice(-40)
              newSafeAddress = getAddress(rawProxyAddress)
              break
            }
          }
        }
      }

      if (!newSafeAddress) {
        throw new Error(
          'Could not find ProxyCreation log in transaction receipt. ' +
            'Check that the addresses/ABIs are correct.'
        )
      }

      consola.success('New Gnosis Safe deployed at:', newSafeAddress)
      consola.success('Setup complete!')

      const GNOSIS_SAFE_VERIFICATION_ABI = parseAbi([
        'function getOwners() view returns (address[])',
        'function getThreshold() view returns (uint256)',
      ])

      if (newSafeAddress) {
        consola.info('Verifying deployed Gnosis Safe configuration...')

        try {
          // fetch Safe owners
          const ownersAfterSetup = await publicClient.readContract({
            address: newSafeAddress,
            abi: GNOSIS_SAFE_VERIFICATION_ABI,
            functionName: 'getOwners',
            args: [],
          })

          // fetch threshold
          const thresholdAfterSetup = await publicClient.readContract({
            address: newSafeAddress,
            abi: GNOSIS_SAFE_VERIFICATION_ABI,
            functionName: 'getThreshold',
            args: [],
          })

          // log the results
          if (
            JSON.stringify(ownersAfterSetup) === JSON.stringify(owners) &&
            BigInt(thresholdAfterSetup) === BigInt(threshold)
          ) {
            consola.success('Owners and threshold match the expected values.')
          } else {
            consola.error('Mismatch in Safe setup configuration!')
            consola.error('Expected Owners:', owners)
            consola.error('Actual Owners:', ownersAfterSetup)
            consola.error('Expected Threshold:', threshold)
            consola.error('Actual Threshold:', thresholdAfterSetup)
          }
        } catch (error) {
          consola.error('Error verifying Gnosis Safe configuration:', error)
        }
      }
    } catch (error: any) {
      consola.error('Error deploying Gnosis Safe:', error.message)
      process.exit(1)
    }
  },
})

runMain(main)
