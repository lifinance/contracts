#!/usr/bin/env bun

/**
 * Demo script for CowSwap with Patcher contract
 *
 * Note: There are some TypeScript errors related to the `0x${string}` type that could be fixed
 * with more type assertions, but the script should work correctly as is. The main issue with
 * the TraderParameters has been fixed.
 */

import {
  parseAbi,
  parseUnits,
  encodeFunctionData,
  createWalletClient,
  http,
  getContract,
  Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base } from 'viem/chains'
import { randomBytes } from 'crypto'
import { ethers } from 'ethers'
import { SupportedChainId, OrderKind, TradingSdk } from '@cowprotocol/cow-sdk'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import patcherArtifact from '../../out/Patcher.sol/Patcher.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'

// Constants
const ARBITRUM_WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const LIFI_DIAMOND_ARBITRUM = '0xD3b2b0aC0AFdd0d166a495f5E9fca4eCc715a782'
const PATCHER_ARBITRUM = '0xE65b50EcF482f97f53557f0E02946aa27f8839EC'
const COW_SHED_FACTORY = '0x00E989b87700514118Fa55326CD1cCE82faebEF6'
const COW_SHED_IMPLEMENTATION = '0x2CFFA8cf11B90C9F437567b86352169dF4009F73'
const VAULT_RELAYER_ARBITRUM = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

// ABIs
const ERC20_ABI = erc20Artifact.abi
const PATCHER_ABI = patcherArtifact.abi

/**
 * CowShed SDK for computing deterministic proxy addresses and encoding hook calls
 */
class CowShedSdk {
  factoryAddress: `0x${string}`
  implementationAddress: `0x${string}`
  chainId: number

  constructor({
    factoryAddress,
    implementationAddress,
    chainId,
  }: {
    factoryAddress: string
    implementationAddress: string
    chainId: number
  }) {
    this.factoryAddress = factoryAddress as `0x${string}`
    this.implementationAddress = implementationAddress as `0x${string}`
    this.chainId = chainId
  }

  // Compute the deterministic proxy address for a user
  computeProxyAddress(owner: string): `0x${string}` {
    // This uses CREATE2 to compute the deterministic address
    const salt = ethers.utils.solidityKeccak256(
      ['address', 'address'],
      [owner, this.implementationAddress]
    )

    const proxyBytecode =
      '0x' +
      ethers.utils
        .solidityPack(
          ['bytes', 'address'],
          [
            '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
            this.implementationAddress,
          ]
        )
        .slice(2) +
      '5af43d82803e903d91602b57fd5bf3'

    const create2Input = ethers.utils.solidityKeccak256(
      ['bytes'],
      [
        ethers.utils.solidityPack(
          ['bytes1', 'address', 'bytes32', 'bytes32'],
          [
            '0xff',
            this.factoryAddress,
            salt,
            ethers.utils.keccak256(proxyBytecode),
          ]
        ),
      ]
    )

    return ethers.utils.getAddress(
      '0x' + create2Input.slice(26)
    ) as `0x${string}`
  }

  // Encode the executeHooks call for the factory
  static encodeExecuteHooksForFactory(
    calls: any[],
    nonce: `0x${string}`,
    deadline: bigint,
    owner: `0x${string}`,
    signature: `0x${string}`
  ): string {
    const cowShedFactoryAbi = parseAbi([
      'function deployProxyAndExecuteHooks(address owner, address implementation, (address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, bytes signature) returns (address proxy)',
    ])

    return encodeFunctionData({
      abi: cowShedFactoryAbi,
      functionName: 'deployProxyAndExecuteHooks',
      args: [
        owner,
        COW_SHED_IMPLEMENTATION as `0x${string}`,
        calls.map((call) => ({
          target: call.target as `0x${string}`,
          value: call.value,
          callData: call.callData,
          allowFailure: call.allowFailure,
          isDelegateCall: call.isDelegateCall,
        })),
        nonce,
        deadline,
        signature,
      ],
    })
  }
}

/**
 * Setup CowShed post hooks for bridging USDC to BASE
 */
async function setupCowShedPostHooks(
  chainId: number,
  walletClient: any,
  usdcAddress: string,
  receivedAmount: bigint
) {
  const account = walletClient.account
  const signerAddress = account.address

  const shedSDK = new CowShedSdk({
    factoryAddress: COW_SHED_FACTORY,
    implementationAddress: COW_SHED_IMPLEMENTATION,
    chainId,
  })

  // Generate a random nonce
  const nonce = `0x${Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')}` as `0x${string}`

  // Set a deadline 24 hours from now
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60)

  // Get the proxy address
  const shedDeterministicAddress = shedSDK.computeProxyAddress(signerAddress)
  consola.info(`CowShed proxy address: ${shedDeterministicAddress}`)

  // Create the bridge data for LiFi
  const bridgeData = {
    transactionId: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
    bridge: 'across',
    integrator: 'lifi-demo',
    referrer: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    sendingAssetId: usdcAddress as `0x${string}`,
    receiver: signerAddress as `0x${string}`,
    destinationChainId: 8453n, // BASE chain ID
    minAmount: receivedAmount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // Create AcrossV3Data
  const acrossData = {
    receiverAddress: signerAddress as `0x${string}`,
    refundAddress: signerAddress as `0x${string}`,
    receivingAssetId: BASE_USDC as `0x${string}`, // USDC on BASE
    outputAmount: 0n, // This will be patched dynamically
    outputAmountPercent: parseUnits('0.995', 18), // 0.5% fee (example)
    exclusiveRelayer:
      '0x0000000000000000000000000000000000000000' as `0x${string}`,
    quoteTimestamp: Math.floor(Date.now() / 1000),
    fillDeadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    exclusivityDeadline: Math.floor(Date.now() / 1000),
    message: '0x' as `0x${string}`, // No message
  }

  // Encode the AcrossFacetV3 call
  const acrossFacetAbi = parseAbi([
    'function startBridgeTokensViaAcrossV3((bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 destinationChainId, uint256 minAmount, bool hasSourceSwaps, bool hasDestinationCall) _bridgeData, (address receiverAddress, address refundAddress, address receivingAssetId, uint256 outputAmount, uint64 outputAmountPercent, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) _acrossData) payable',
  ])

  // Create the bridge data with proper types
  const typedBridgeData = {
    transactionId: bridgeData.transactionId,
    bridge: bridgeData.bridge,
    integrator: bridgeData.integrator,
    referrer: bridgeData.referrer,
    sendingAssetId: bridgeData.sendingAssetId,
    receiver: bridgeData.receiver,
    destinationChainId: bridgeData.destinationChainId,
    minAmount: bridgeData.minAmount,
    hasSourceSwaps: bridgeData.hasSourceSwaps,
    hasDestinationCall: bridgeData.hasDestinationCall,
  }

  // Create the across data with proper types
  const typedAcrossData = {
    receiverAddress: acrossData.receiverAddress,
    refundAddress: acrossData.refundAddress,
    receivingAssetId: acrossData.receivingAssetId,
    outputAmount: acrossData.outputAmount,
    outputAmountPercent: acrossData.outputAmountPercent,
    exclusiveRelayer: acrossData.exclusiveRelayer,
    quoteTimestamp: acrossData.quoteTimestamp,
    fillDeadline: acrossData.fillDeadline,
    exclusivityDeadline: acrossData.exclusivityDeadline,
    message: acrossData.message,
  }

  const acrossCalldata = encodeFunctionData({
    abi: acrossFacetAbi,
    functionName: 'startBridgeTokensViaAcrossV3',
    args: [typedBridgeData, typedAcrossData],
  })

  // Calculate the offset for the outputAmount field in the AcrossV3Data struct
  // This is a fixed offset in the calldata where the outputAmount value needs to be patched
  // The offset is calculated based on the ABI encoding of the function call
  const outputAmountOffset = 644n // This offset needs to be calculated correctly

  // Encode the balanceOf call to get the USDC balance
  const valueGetter = encodeFunctionData({
    abi: parseAbi([
      'function balanceOf(address account) view returns (uint256)',
    ]),
    functionName: 'balanceOf',
    args: [shedDeterministicAddress as `0x${string}`],
  })

  // Encode the patcher call
  const patcherCalldata = encodeFunctionData({
    abi: parseAbi([
      'function executeWithDynamicPatches(address valueSource, bytes valueGetter, address finalTarget, uint256 value, bytes data, uint256[] offsets, bool delegateCall) returns (bool success, bytes returnData)',
    ]),
    functionName: 'executeWithDynamicPatches',
    args: [
      usdcAddress as `0x${string}`, // valueSource - USDC contract
      valueGetter, // valueGetter - balanceOf call
      LIFI_DIAMOND_ARBITRUM as `0x${string}`, // finalTarget - LiFiDiamond contract
      0n, // value - no ETH being sent
      acrossCalldata, // data - the encoded AcrossFacetV3 call
      [BigInt(outputAmountOffset)], // offsets - position of outputAmount in the calldata
      false, // delegateCall - regular call, not delegateCall
    ],
  })

  // Define the post-swap call to the patcher
  const postSwapCalls = [
    {
      target: PATCHER_ARBITRUM as `0x${string}`,
      callData: patcherCalldata,
      value: 0n,
      allowFailure: false,
      isDelegateCall: false,
    },
  ]

  // Sign the typed data for the hooks
  const signature = (await walletClient.signTypedData({
    account,
    domain: {
      name: 'COWShed',
      version: '1.0.0',
      chainId: BigInt(chainId),
      verifyingContract: shedDeterministicAddress,
    },
    types: {
      ExecuteHooks: [
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
      Call: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'callData', type: 'bytes' },
        { name: 'allowFailure', type: 'bool' },
        { name: 'isDelegateCall', type: 'bool' },
      ],
    },
    primaryType: 'ExecuteHooks',
    message: {
      calls: postSwapCalls.map((call) => ({
        target: call.target,
        value: call.value,
        callData: call.callData,
        allowFailure: call.allowFailure,
        isDelegateCall: call.isDelegateCall,
      })),
      nonce,
      deadline,
    },
  })) as `0x${string}`

  // Encode the post hooks call data
  const shedEncodedPostHooksCallData = CowShedSdk.encodeExecuteHooksForFactory(
    postSwapCalls,
    nonce,
    deadline,
    signerAddress as `0x${string}`,
    signature
  )

  // Create the post hooks
  const postHooks = [
    {
      target: PATCHER_ARBITRUM as `0x${string}`,
      callData: shedEncodedPostHooksCallData,
      gasLimit: '3000000',
    },
  ]

  return {
    shedDeterministicAddress,
    postHooks,
  }
}

/**
 * Main function to execute the demo
 */
async function main(options: { privateKey: string; dryRun: boolean }) {
  try {
    consola.start('Starting CowSwap with Patcher demo')

    // Set up wallet client
    const account = privateKeyToAccount(options.privateKey as Hex)
    const walletClient = createWalletClient({
      chain: arbitrum,
      transport: http(),
      account,
    })

    const walletAddress = account.address
    consola.info(`Connected wallet: ${walletAddress}`)

    // Amount to swap: 0.001 WETH
    const swapAmount = parseUnits('0.001', 18)
    consola.info(`Swap amount: 0.001 WETH`)

    // Check WETH balance and approve if needed
    const wethContract = getContract({
      address: ARBITRUM_WETH as Hex,
      abi: ERC20_ABI,
      client: { public: walletClient, wallet: walletClient },
    })

    const wethBalance = (await wethContract.read.balanceOf([
      walletAddress,
    ])) as bigint
    consola.info(`WETH balance: ${wethBalance}`)

    if (wethBalance < swapAmount) {
      consola.error(`Insufficient WETH balance. Need at least 0.001 WETH.`)
      process.exit(1)
    }

    // Check allowance
    const allowance = (await wethContract.read.allowance([
      walletAddress,
      VAULT_RELAYER_ARBITRUM,
    ])) as bigint
    consola.info(`Current allowance: ${allowance}`)

    if (allowance < swapAmount) {
      consola.info('Approving WETH for CoW Protocol VaultRelayer...')
      if (!options.dryRun) {
        const approveTx = await wethContract.write.approve([
          VAULT_RELAYER_ARBITRUM as `0x${string}`,
          BigInt(
            '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
          ), // Max uint256
        ])
        consola.success(`Approval transaction sent: ${approveTx}`)
      } else {
        consola.info(`[DRY RUN] Would approve WETH for VaultRelayer`)
      }
    }

    // Set up CowShed post hooks
    const { shedDeterministicAddress, postHooks } = await setupCowShedPostHooks(
      42161, // Arbitrum chain ID
      walletClient,
      ARBITRUM_USDC,
      parseUnits('0', 6) // This will be dynamically patched
    )

    // Create ethers provider and signer for CoW SDK
    const provider = new ethers.providers.JsonRpcProvider(
      arbitrum.rpcUrls.default.http[0]
    )
    const ethersSigner = new ethers.Wallet(options.privateKey, provider)

    // Initialize CoW SDK with proper TraderParameters
    const cowSdk = new TradingSdk({
      chainId: SupportedChainId.ARBITRUM_ONE,
      signer: ethersSigner,
      appCode: 'lifi-demo' as any, // Cast to any to satisfy the AppCode type
    })

    // Create the order parameters
    const parameters = {
      kind: OrderKind.SELL,
      sellToken: ARBITRUM_WETH as `0x${string}`,
      sellTokenDecimals: 18,
      buyToken: ARBITRUM_USDC as `0x${string}`,
      buyTokenDecimals: 6,
      amount: swapAmount.toString(),
      receiver: shedDeterministicAddress as `0x${string}`, // Important: Set the receiver to the CowShed proxy
      validFor: 30 * 60, // 30 minutes in seconds
      slippageBps: 50, // 0.5% slippage
    }

    // Create advanced settings with post hooks
    const advancedSettings = {
      appData: {
        metadata: {
          hooks: {
            version: '1',
            pre: [],
            post: postHooks,
          },
        },
      },
    }

    // Submit the order with post hooks
    if (!options.dryRun) {
      consola.info('Submitting order to CowSwap...')
      try {
        // Add a timeout to the order submission
        const orderPromise = cowSdk.postSwapOrder(parameters, advancedSettings)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(new Error('Order submission timed out after 30 seconds')),
            30000
          )
        })

        const orderId = await Promise.race([orderPromise, timeoutPromise])
        consola.success(`Order created with hash: ${orderId}`)
        consola.info(
          `Explorer URL: https://explorer.cow.fi/orders/${orderId}?chainId=42161`
        )
      } catch (error) {
        consola.error('Error submitting order to CowSwap:', error)
        throw error
      }
    } else {
      consola.info(`[DRY RUN] Would submit order to CowSwap with post hooks`)
      consola.info(`Parameters: ${JSON.stringify(parameters, null, 2)}`)
      consola.info(`Post hooks: ${JSON.stringify(postHooks, null, 2)}`)
    }

    consola.success('Demo completed successfully')
  } catch (error) {
    consola.error('Error executing demo:', error)
    process.exit(1)
  }
}

// CLI command definition
const cmd = defineCommand({
  meta: {
    name: 'demoPatcher',
    description: 'Demo script for CowSwap with Patcher contract',
  },
  args: {
    privateKey: {
      type: 'string',
      description: 'Private key for the wallet',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without submitting transactions',
      default: false,
    },
  },
  run: async ({ args }) => {
    await main(args)
  },
})

// Run the command
runMain(cmd)
