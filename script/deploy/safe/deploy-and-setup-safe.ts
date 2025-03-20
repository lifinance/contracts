/**
 * Deploy and Setup a new multisig Safe
 */

import { defineCommand, runMain } from 'citty'
import {
  encodeFunctionData,
  isAddress,
  parseAbi,
  getAddress,
  Address,
} from 'viem'
import consola from 'consola'
import * as dotenv from 'dotenv'
import { SupportedChain } from '../../demoScripts/utils/demoScriptChainConfig'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import globalConfig from '../../../config/global.json'
dotenv.config()

const GNOSIS_SAFE_PROXY_FACTORY_ABI = parseAbi([
  'function createProxy(address _singleton, bytes initializer) returns (address proxy)',
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
    description: 'Deploys a new Gnosis Safe proxy and calls setup(...)',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name (e.g., arbitrum)',
      required: true,
    },
    owners: {
      type: 'string',
      description: 'Comma-separated list of owner addresses (e.g. 0xabc,0xdef)',
      required: false,
    },
    threshold: {
      type: 'string',
      description: 'Safe threshold (number of signatures required)',
      required: true,
    },
    safeSingleton: {
      type: 'string',
      description: 'Address of the Gnosis Safe singleton contract',
      required: true,
    },
    proxyFactory: {
      type: 'string',
      description: 'Address of the Gnosis Safe Proxy Factory contract',
      required: true,
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
      const safeSingleton = args.safeSingleton
      const proxyFactory = args.proxyFactory

      const { walletAccount, publicClient, walletClient } =
        await setupEnvironment(networkName, null) // takes PRIVATE_KEY from .env

      consola.info('Deployer (signer) address:', walletAccount.address)

      const ownersArg = args.owners || ''
      const ownersRaw = ownersArg
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)

      // validate owners
      const ownersFromGlobalConfig = globalConfig.safeOwners
      const ownersFromArgs = ownersRaw.map((o) => {
        if (!isAddress(o)) {
          throw new Error(`Invalid address in --owners: ${o}`)
        }
        return getAddress(o)
      })

      const owners = [...ownersFromGlobalConfig, ...ownersFromArgs]

      if (threshold > owners.length) {
        throw new Error('Threshold cannot be greater than the number of owners')
      }

      // optional parameters
      const fallbackHandler =
        args.fallbackHandler && isAddress(args.fallbackHandler)
          ? getAddress(args.fallbackHandler)
          : `0x${'0'.repeat(40)}`

      const paymentToken =
        args.paymentToken && isAddress(args.paymentToken)
          ? getAddress(args.paymentToken)
          : `0x${'0'.repeat(40)}`

      const payment = args.payment ? BigInt(args.payment) : 0n
      const paymentReceiver =
        args.paymentReceiver && isAddress(args.paymentReceiver)
          ? getAddress(args.paymentReceiver)
          : `0x${'0'.repeat(40)}`

      consola.info('Network:', networkName)
      consola.info('Master Copy:', safeSingleton)
      consola.info('Proxy Factory:', proxyFactory)
      consola.info('Owners:', owners)
      consola.info('Threshold:', threshold)
      consola.info('Fallback Handler:', fallbackHandler)
      consola.info('Payment Token:', paymentToken)
      consola.info('Payment:', payment)
      consola.info('Payment Receiver:', paymentReceiver)

      // encode the setup(...) call data for the Gnosis Safe
      const initData = encodeFunctionData({
        abi: GNOSIS_SAFE_ABI,
        functionName: 'setup',
        args: [
          owners, // address[] _owners
          BigInt(threshold), // uint256 _threshold
          `0x${'0'.repeat(40)}`, // address to (set to 0 if no call)
          '0x', // bytes data (empty)
          fallbackHandler, // address fallbackHandler
          paymentToken, // address paymentToken
          payment, // uint256 payment
          paymentReceiver, // address payable paymentReceiver
        ],
      })

      // call createProxy(...) on the proxyFactory
      consola.info('Creating Gnosis Safe Proxy via Factory...')
      const hash = await walletClient.writeContract({
        address: proxyFactory,
        abi: GNOSIS_SAFE_PROXY_FACTORY_ABI,
        functionName: 'createProxy',
        args: [safeSingleton, initData],
      })
      consola.info('Transaction sent. Hash:', hash)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      consola.info('Transaction confirmed in block', receipt.blockNumber)

      // retrieve the new proxy address from logs (the GnosisSafeProxyFactory emits `ProxyCreation(proxy, singleton)`)
      let newSafeAddress: Address | undefined
      if (receipt.logs) {
        for (const log of receipt.logs) {
          const proxyCreationTopic =
            '0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235'
          if (log.address.toLowerCase() === proxyFactory.toLowerCase()) {
            // - topic[0] = keccak256(ProxyCreation) - topic
            // data contains proxy contract address
            if (log && log.topics[0] == proxyCreationTopic) {
              const rawProxyAddress = `0x${log.data.slice(
                26,
                66
              )}` as `0x${string}`
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
          })

          // fetch threshold
          const thresholdAfterSetup = await publicClient.readContract({
            address: newSafeAddress,
            abi: GNOSIS_SAFE_VERIFICATION_ABI,
            functionName: 'getThreshold',
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
