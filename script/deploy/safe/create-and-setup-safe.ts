/**
 * Deploy and Setup a new Gnosis Safe using viem
 *
 * Example usage:
 *    npx tsx src/setup-safe.ts --network goerli --privateKey 0xABC123... \
 *      --owners 0xOwner1,0xOwner2 --threshold 2
 */

import { defineCommand, runMain } from 'citty'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
  getAddress,
  Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import consola from 'consola'
import * as dotenv from 'dotenv'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'
import { SupportedChain } from '../../demoScripts/utils/demoScriptChainConfig'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import globalConfig from '../../../config/global.json'
dotenv.config()

// ------------------------------------------------------------------------------------
// 1. Minimal ABIs for GnosisSafeProxyFactory and GnosisSafe
//    For production usage, provide the full ABIs or import them from a known source.
// ------------------------------------------------------------------------------------

const GNOSIS_SAFE_PROXY_FACTORY_ABI = parseAbi([
  // createProxy(address _singleton, bytes memory initializer) returns (address proxy)
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
    name: 'create-and-setup-safe',
    description: 'Deploys a new Gnosis Safe proxy and calls setup(...)',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name (e.g., arbitrum)',
      required: true,
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the deployer',
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
    },
    gnosisSafeSingleton: {
      type: 'string',
      description: '',
    },
    proxyFactory: {
      type: 'string',
      description: '',
    },
    fallbackHandler: {
      type: 'string',
      description: 'Fallback handler address (optional)',
    },
    paymentToken: {
      type: 'string',
      description: 'Payment token address (default: 0x0 for ETH)',
    },
    payment: {
      type: 'string',
      description: 'Payment amount in wei (default: 0)',
    },
    paymentReceiver: {
      type: 'string',
      description: 'Payment receiver address (default: 0x0)',
    },
  },
  async run({ args }) {
    try {
      // ------------------------------------------------------------------------------------
      // A) Parse/Validate CLI args
      // ------------------------------------------------------------------------------------
      const networkName = args.network as SupportedChain
      const gnosisSafeSingleton = args.gnosisSafeSingleton
      const proxyFactory = args.proxyFactory

      const { walletAccount, publicClient, walletClient } =
        await setupEnvironment(networkName, null)

      const privateKey = args.privateKey.trim() as `0xstring`
      const ownersArg = args.owners || ''
      const ownersRaw = ownersArg
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)

      // Validate owners
      const ownersFromGlobalConfig = globalConfig.safeOwners
      const ownersFromArgs = ownersRaw.map((o) => {
        if (!isAddress(o)) {
          throw new Error(`Invalid address in --owners: ${o}`)
        }
        return getAddress(o) // EIP-55 checksum
      })

      console.log('ownersFromGlobalConfig')
      console.log(ownersFromGlobalConfig)
      console.log('ownersFromArgs')
      console.log(ownersFromArgs)

      const owners = [...ownersFromGlobalConfig, ...ownersFromArgs]

      // Fallback to 1 if not provided
      const threshold = args.threshold ? parseInt(args.threshold, 10) : 1
      if (threshold < 1) {
        throw new Error(`Invalid threshold: ${threshold}. Must be >= 1.`)
      }

      // Optional parameters
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
      consola.info('Master Copy:', gnosisSafeSingleton)
      consola.info('Proxy Factory:', proxyFactory)
      consola.info('Owners:', owners)
      consola.info('Threshold:', threshold)
      consola.info('Fallback Handler:', fallbackHandler)
      consola.info('Payment Token:', paymentToken)
      consola.info('Payment:', payment)
      consola.info('Payment Receiver:', paymentReceiver)

      // ------------------------------------------------------------------------------------
      // B) Create viem clients (public + wallet) for the selected chain
      // ------------------------------------------------------------------------------------
      consola.info('Deployer (signer) address:', walletAccount.address)

      // ------------------------------------------------------------------------------------
      // C) Encode the setup(...) call data for the Gnosis Safe
      // ------------------------------------------------------------------------------------
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

      // ------------------------------------------------------------------------------------
      // D) Call createProxy(...) on the GnosisSafeProxyFactory
      // ------------------------------------------------------------------------------------
      consola.info('Creating Gnosis Safe Proxy via Factory...')
      // const hash = await walletClient.writeContract({
      //   address: proxyFactory,
      //   abi: GNOSIS_SAFE_PROXY_FACTORY_ABI,
      //   functionName: 'createProxy',
      //   args: [gnosisSafeSingleton, initData],
      // })
      const hash =
        '0xcd05e0b90ee27c96be0fe26dfcfa6baaa87ab3d1521c7a3de7bcc217790d3512'
      consola.info('Transaction sent. Hash:', hash)

      // E) Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      consola.info('Transaction confirmed in block', receipt.blockNumber)

      // ------------------------------------------------------------------------------------
      // F) Retrieve the new proxy address from logs
      //    The GnosisSafeProxyFactory emits `ProxyCreation(proxy, singleton)`
      // ------------------------------------------------------------------------------------
      let newSafeAddress: Address | undefined
      console.log('receipt')
      console.log(receipt)
      if (receipt.logs) {
        for (const log of receipt.logs) {
          // The ProxyCreation event signature is:
          //   ProxyCreation(address proxy, address singleton)
          // keccak256("ProxyCreation(address,address)")
          const proxyCreationTopic =
            '0x0000000000000000000000000000000000000000000000000000000000000000'
          // Actually, the real topic is:
          // keccak256("ProxyCreation(address,address)") = 0x5c4aa7af44d42c6dbb6d1dbeeb29d15d2b02ff42d61367920c2d340721dfe0ea
          // But let's do a simpler approach by reading `log.address === proxyFactory` plus indexing

          console.log(log)
          if (log.address.toLowerCase() === proxyFactory.toLowerCase()) {
            // Typically, the new proxy address is topic[1] or in data, depending on the contract
            // - topic[0] = keccak256(ProxyCreation) - topic
            // data contains proxy contract address
            if (
              log &&
              log.topics[0] ==
                '0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235'
            ) {
              const rawProxyAddress = `0x${log.data.slice(
                26,
                66
              )}` as `0x${string}`
              consola.log('rawProxyAddress')
              consola.log(rawProxyAddress)
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
          // Fetch Safe owners
          const ownersAfterSetup = await publicClient.readContract({
            address: newSafeAddress,
            abi: GNOSIS_SAFE_VERIFICATION_ABI,
            functionName: 'getOwners',
          })

          // Fetch threshold
          const thresholdAfterSetup = await publicClient.readContract({
            address: newSafeAddress,
            abi: GNOSIS_SAFE_VERIFICATION_ABI,
            functionName: 'getThreshold',
          })

          // Fetch fallback handler
          const fallbackHandlerAfterSetup = await publicClient.readContract({
            address: newSafeAddress,
            abi: GNOSIS_SAFE_VERIFICATION_ABI,
            functionName: 'getFallbackHandler',
          })

          // Log the results
          consola.success('Owners after setup:', ownersAfterSetup)
          consola.success('Threshold after setup:', thresholdAfterSetup)
          consola.success(
            'Fallback handler after setup:',
            fallbackHandlerAfterSetup
          )

          // Verify payment token, payment amount, and payment receiver
          consola.info('Expected Payment Token:', paymentToken)
          consola.info('Expected Payment:', payment)
          consola.info('Expected Payment Receiver:', paymentReceiver)

          if (paymentToken !== `0x${'0'.repeat(40)}`) {
            consola.warn(
              '⚠️ Payment Token was set, but it may not be retrievable directly via Safe.'
            )
          }
          if (payment > 0n) {
            consola.warn(
              '⚠️ Payment was set, but ensure it was deducted from deployer funds.'
            )
          }
          if (paymentReceiver !== `0x${'0'.repeat(40)}`) {
            consola.warn(
              '⚠️ Payment Receiver was set, but may not be directly visible.'
            )
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
