import { parseAbi, encodeFunctionData, parseUnits, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { createPublicClient, createWalletClient, http } from 'viem'
import { ethers } from 'ethers'
import {
  SupportedChainId,
  OrderKind,
  TradingSdk,
  TradeParameters,
  SwapAdvancedSettings,
} from '@cowprotocol/cow-sdk'
import { CowShedSdk } from './utils/lib/cowShedSdk'
import deploymentsArbitrum from '../../deployments/arbitrum.staging.json'

// Import necessary types and utilities
import { logKeyValue, logSectionHeader, logSuccess } from './utils/lib/logging'
import { truncateCalldata } from './utils/lib/formatting'
import { left, Result, right } from './utils/lib/result'

// Define CoW Protocol constants
const COW_SHED_FACTORY =
  '0x00E989b87700514118Fa55326CD1cCE82faebEF6' as `0x${string}`
const COW_SHED_IMPLEMENTATION =
  '0x2CFFA8cf11B90C9F437567b86352169dF4009F73' as `0x${string}`

// Define interfaces and types
interface Token {
  readonly address: `0x${string}`
  readonly decimals: number
}

interface ICall {
  target: `0x${string}`
  callData: `0x${string}`
  value: bigint
  allowFailure: boolean
  isDelegateCall: boolean
}

interface PatchOperation {
  valueSource: `0x${string}`
  valueGetter: `0x${string}`
  valueToReplace: string | number | bigint
}

type TransactionIntent =
  | {
      readonly type: 'regular'
      readonly targetAddress: `0x${string}`
      readonly callData: `0x${string}`
      readonly nativeValue?: bigint
      readonly allowFailure?: boolean
      readonly isDelegateCall?: boolean
    }
  | {
      readonly type: 'dynamicValue'
      readonly patcherAddress: `0x${string}`
      readonly valueSource: `0x${string}`
      readonly valueGetter: `0x${string}`
      readonly targetAddress: `0x${string}`
      readonly callDataToPatch: `0x${string}`
      readonly valueToReplace: string | number | bigint
      readonly nativeValue?: bigint
      readonly delegateCall?: boolean
    }
  | {
      readonly type: 'multiPatch'
      readonly patcherAddress: `0x${string}`
      readonly targetAddress: `0x${string}`
      readonly callDataToPatch: `0x${string}`
      readonly patchOperations: readonly PatchOperation[]
      readonly nativeValue?: bigint
      readonly delegateCall?: boolean
    }

// ABIs
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const DUMMY_TARGET_ABI = parseAbi([
  'function deposit(address token, uint256 amount, bool flag) returns (bool)',
  'function multiDeposit(address token, uint256 amount1, uint256 amount2, bool flag) returns (bool)',
  'function getDoubledBalance(address token, address account) view returns (uint256)',
])

const PATCHER_ABI = parseAbi([
  'function dynamicValuePatch(address valueSource, bytes valueGetter, address targetAddress, bytes callDataToPatch, bytes32 valueToReplace, uint256 offset, bool delegateCall) payable returns (bytes memory)',
  'function multiPatch(address targetAddress, bytes callDataToPatch, (address valueSource, bytes valueGetter, bytes32 valueToReplace, uint256 offset)[] patchOperations, bool delegateCall) payable returns (bytes memory)',
])

// Log CoW Shed constants
console.log('Using COW_SHED_FACTORY:', COW_SHED_FACTORY)
console.log('Using COW_SHED_IMPLEMENTATION:', COW_SHED_IMPLEMENTATION)

// Helper functions
const encodeBalanceOfCall = (account: string): `0x${string}` => {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account as `0x${string}`],
  })
}

const encodeTransferCall = (to: string, amount: string): `0x${string}` => {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to as `0x${string}`, BigInt(amount)],
  })
}

const encodeGetDoubledBalanceCall = (
  token: string,
  account: string
): `0x${string}` => {
  return encodeFunctionData({
    abi: DUMMY_TARGET_ABI,
    functionName: 'getDoubledBalance',
    args: [token as `0x${string}`, account as `0x${string}`],
  })
}

// Process transaction intent
const processTransactionIntent = (
  intent: TransactionIntent,
  verbose: boolean
): Result<Error, ICall> => {
  switch (intent.type) {
    case 'regular': {
      const call: ICall = {
        target: intent.targetAddress,
        callData: intent.callData,
        value: intent.nativeValue ?? BigInt(0),
        allowFailure: intent.allowFailure ?? false,
        isDelegateCall: intent.isDelegateCall ?? false,
      }

      if (verbose) {
        logKeyValue('Call data', truncateCalldata(intent.callData, 10))
        logSuccess('Regular call created')
      }

      return right(call)
    }

    case 'dynamicValue': {
      try {
        if (!intent.patcherAddress || intent.patcherAddress === zeroAddress) {
          return left(new Error('patcherAddress must be provided'))
        }

        if (verbose) {
          logSectionHeader(`Creating dynamic value patch call`)
          logKeyValue('Call', truncateCalldata(intent.callDataToPatch, 10))
          logKeyValue('Value Source', intent.valueSource)
          logKeyValue('Value Getter', truncateCalldata(intent.valueGetter, 10))
          logKeyValue('Target', intent.targetAddress)
          logKeyValue('Value to replace', intent.valueToReplace.toString())
          logKeyValue(
            'Native Value',
            (intent.nativeValue || BigInt(0)).toString()
          )
        }

        // Create dynamic patch call
        const callData = encodeFunctionData({
          abi: PATCHER_ABI,
          functionName: 'dynamicValuePatch',
          args: [
            intent.valueSource,
            intent.valueGetter,
            intent.targetAddress,
            intent.callDataToPatch,
            `0x${intent.valueToReplace
              .toString()
              .padStart(64, '0')}` as `0x${string}`,
            BigInt(0), // offset
            intent.delegateCall ?? false,
          ],
        })

        const call: ICall = {
          target: intent.patcherAddress,
          callData,
          value: intent.nativeValue ?? BigInt(0),
          allowFailure: false,
          isDelegateCall: false,
        }

        if (verbose) {
          logSuccess('Dynamic value patch call created')
        }

        return right(call)
      } catch (error) {
        return left(
          new Error(
            `Failed to create dynamic value patch: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      }
    }

    case 'multiPatch': {
      try {
        if (verbose) {
          logSectionHeader(
            `Creating multi-patch call with ${intent.patchOperations.length} operations`
          )
          logKeyValue(
            'Call data to patch',
            truncateCalldata(intent.callDataToPatch, 10)
          )
          logKeyValue('Target', intent.targetAddress)
        }

        // Format patch operations for the contract call
        const patchOperations = intent.patchOperations.map((op) => {
          return {
            valueSource: op.valueSource,
            valueGetter: op.valueGetter,
            valueToReplace: `0x${op.valueToReplace
              .toString()
              .padStart(64, '0')}` as `0x${string}`,
            offset: BigInt(0),
          }
        })

        // Create multi-patch call
        const callData = encodeFunctionData({
          abi: PATCHER_ABI,
          functionName: 'multiPatch',
          args: [
            intent.targetAddress,
            intent.callDataToPatch,
            patchOperations,
            intent.delegateCall ?? false,
          ],
        })

        const call: ICall = {
          target: intent.patcherAddress,
          callData,
          value: intent.nativeValue ?? BigInt(0),
          allowFailure: false,
          isDelegateCall: false,
        }

        if (verbose) {
          logSuccess('Multi-patch call created')
        }

        return right(call)
      } catch (error) {
        return left(
          new Error(
            `Failed to create multi-patch: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      }
    }
  }
}

// Using the CowShedSdk implementation from utils/lib/cowShedSdk.ts

// Real implementation of CoW Protocol functions
const calculateCowShedProxyAddress = async (
  chainId: number,
  owner: string
): Promise<string> => {
  console.log('calculateCowShedProxyAddress called with:', { chainId, owner })

  if (!owner || owner === '0x0000000000000000000000000000000000000000') {
    throw new Error('Owner address is undefined or empty')
  }

  console.log('Using COW_SHED_FACTORY:', COW_SHED_FACTORY)
  console.log('Using COW_SHED_IMPLEMENTATION:', COW_SHED_IMPLEMENTATION)

  // Validate inputs before creating the SDK
  if (
    !COW_SHED_FACTORY ||
    COW_SHED_FACTORY === '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error('COW_SHED_FACTORY is undefined or invalid')
  }

  if (
    !COW_SHED_IMPLEMENTATION ||
    COW_SHED_IMPLEMENTATION === '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error('COW_SHED_IMPLEMENTATION is undefined or invalid')
  }

  // Use our new CowShedSdk implementation
  const shedSDK = new CowShedSdk({
    factoryAddress: COW_SHED_FACTORY,
    implementationAddress: COW_SHED_IMPLEMENTATION,
    chainId,
  })

  const proxyAddress = shedSDK.computeProxyAddress(owner)
  console.log('Computed proxy address:', proxyAddress)
  return proxyAddress
}

const setupCowShedPostHooks = async (
  chainId: number,
  walletClient: any,
  calls: ICall[],
  verbose: boolean
): Promise<{ shedDeterministicAddress: string; postHooks: any[] }> => {
  const account = walletClient.account
  const signerAddress = account.address

  console.log('Using COW_SHED_FACTORY:', COW_SHED_FACTORY)
  console.log('Using COW_SHED_IMPLEMENTATION:', COW_SHED_IMPLEMENTATION)

  const shedSDK = new CowShedSdk({
    factoryAddress: COW_SHED_FACTORY,
    implementationAddress: COW_SHED_IMPLEMENTATION,
    chainId,
  })

  // Generate nonce and deadline for CoW Shed
  const nonce = `0x${Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')}` as `0x${string}`
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200) // now + 2 hours

  // Get the proxy address
  const shedDeterministicAddress = shedSDK.computeProxyAddress(signerAddress)

  // Sign the post hooks
  const hashToSign = shedSDK.hashToSignWithUser(
    calls,
    nonce,
    deadline,
    signerAddress
  )

  // Sign with the wallet
  const signature = await walletClient.signMessage({
    account,
    message: { raw: hashToSign },
  })

  // Encode the post hooks call data
  const shedEncodedPostHooksCallData = CowShedSdk.encodeExecuteHooksForFactory(
    calls,
    nonce,
    deadline,
    signerAddress,
    signature
  )

  // Log the encoded post hooks calldata
  console.log('Encoded post hooks calldata:')
  console.log(`Calldata: ${shedEncodedPostHooksCallData}`)
  console.log(`Calldata length: ${shedEncodedPostHooksCallData.length} bytes`)

  // Create the post hooks
  const postHooks = [
    {
      target: COW_SHED_FACTORY,
      callData: shedEncodedPostHooksCallData,
      gasLimit: '3000000', // Increased gas limit for full calldata
    },
  ]

  // Log information if verbose is true
  if (verbose) {
    logKeyValue('CoW-Shed deterministic address', shedDeterministicAddress)
    logSuccess('Post hook ready for execution through CoW Protocol')
    logKeyValue(
      'CoW-Shed encoded post-hook',
      truncateCalldata(shedEncodedPostHooksCallData, 25)
    )
  }

  return {
    shedDeterministicAddress,
    postHooks,
  }
}

const cowFlow = async (
  chainId: number,
  walletClient: any,
  fromToken: Token,
  toToken: Token,
  fromAmount: bigint,
  postReceiver: string,
  preHooks: readonly any[],
  postHooks: readonly any[]
): Promise<Result<Error, string>> => {
  try {
    console.log('Executing CoW Protocol flow...')
    console.log('From token:', fromToken.address)
    console.log('To token:', toToken.address)
    console.log('Amount:', fromAmount.toString())
    console.log('Receiver:', postReceiver)
    console.log('Post hooks count:', postHooks.length)

    // Get the private key from the environment
    const privateKeyRaw = process.env.PRIVATE_KEY
    if (!privateKeyRaw) {
      throw new Error('PRIVATE_KEY environment variable is not set')
    }

    // Ensure the private key has the correct format
    const privateKey = privateKeyRaw.startsWith('0x')
      ? privateKeyRaw
      : `0x${privateKeyRaw}`

    // Create an ethers.js wallet from the private key
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.ETH_NODE_URI_ARBITRUM
    )
    const ethersSigner = new ethers.Wallet(privateKey, provider)

    // Initialize the CoW Protocol SDK with the ethers.js signer for Arbitrum
    const cowSdk = new TradingSdk({
      chainId: SupportedChainId.ARBITRUM_ONE,
      signer: ethersSigner,
      appCode: 'LiFi',
    })

    // Get the VaultRelayer address for Arbitrum
    const vaultRelayerAddress = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
    console.log(`VaultRelayer address: ${vaultRelayerAddress}`)

    // Create ERC20 contract instance for the sell token
    const sellTokenContract = new ethers.Contract(
      fromToken.address,
      [
        'function approve(address spender, uint256 amount) public returns (bool)',
        'function allowance(address owner, address spender) public view returns (uint256)',
      ],
      ethersSigner
    )

    // Check current allowance
    const currentAllowance = await sellTokenContract.allowance(
      ethersSigner.address,
      vaultRelayerAddress
    )
    console.log(`Current allowance: ${currentAllowance.toString()}`)

    // If allowance is insufficient, approve the token
    if (currentAllowance.lt(fromAmount)) {
      console.log('Approving token for CoW Protocol VaultRelayer...')
      const maxApproval = ethers.constants.MaxUint256
      const approveTx = await sellTokenContract.approve(
        vaultRelayerAddress,
        maxApproval
      )
      console.log(`Approval transaction hash: ${approveTx.hash}`)

      // Wait for the approval transaction to be confirmed
      console.log('Waiting for approval transaction to be confirmed...')
      await approveTx.wait()
      console.log('Token approved successfully')
    } else {
      console.log('Token already has sufficient allowance')
    }

    // Create the order parameters
    const parameters: TradeParameters = {
      kind: OrderKind.SELL,
      sellToken: fromToken.address,
      sellTokenDecimals: fromToken.decimals,
      buyToken: toToken.address,
      buyTokenDecimals: toToken.decimals,
      amount: fromAmount.toString(),
      receiver: postReceiver,
      // Add a reasonable validity period (30 minutes)
      validFor: 30 * 60, // 30 minutes in seconds
      // Add a reasonable slippage (0.5%)
      slippageBps: 50,
    }

    // Add post hooks - this script requires post hooks
    if (!postHooks || postHooks.length === 0) {
      return left(
        new Error('Post hooks are required for this script to function')
      )
    }

    // Create post hooks with full calldata
    const simplifiedPostHooks = postHooks.map((hook) => ({
      target: hook.target,
      callData: hook.callData, // Use the full calldata without truncation
      gasLimit: '3000000',
    }))

    // Log the full calldata for debugging
    console.log('Full post hook calldata:')
    simplifiedPostHooks.forEach((hook, index) => {
      console.log(`Hook ${index + 1} target: ${hook.target}`)
      console.log(`Hook ${index + 1} calldata: ${hook.callData}`)
      console.log(
        `Hook ${index + 1} calldata length: ${hook.callData.length} bytes`
      )
    })

    // Create advanced settings with the correct format
    const advancedSettings: SwapAdvancedSettings = {
      appData: {
        metadata: {
          hooks: {
            version: '1',
            pre: [],
            post: simplifiedPostHooks,
          },
        },
      },
    }

    // Submit the order with post hooks
    const orderId = await cowSdk.postSwapOrder(parameters, advancedSettings)
    return right(orderId)
  } catch (error) {
    console.error('CoW Protocol error details:', error)
    return left(
      new Error(
        `Failed to execute CoW flow: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    )
  }
}

// Main demo function
const demoPatcher = async (): Promise<Result<Error, string>> => {
  try {
    logSectionHeader('Running Patcher Example with Post-Swap Flow')

    // Setup environment
    console.log('Setting up environment...')

    // Get private key and ensure it has the correct format
    const privateKeyRaw = process.env.PRIVATE_KEY
    if (!privateKeyRaw) {
      throw new Error('PRIVATE_KEY environment variable is not set')
    }

    // Ensure the private key has the correct format (0x prefix)
    const privateKey = privateKeyRaw.startsWith('0x')
      ? (privateKeyRaw as `0x${string}`)
      : (`0x${privateKeyRaw}` as `0x${string}`)

    console.log('Creating account...')
    const account = privateKeyToAccount(privateKey)
    console.log('Account address:', account.address)

    console.log('Creating clients for Arbitrum...')
    const rpcUrl = process.env.ETH_NODE_URI_ARBITRUM
    if (!rpcUrl) {
      throw new Error('ETH_NODE_URI_ARBITRUM environment variable is not set')
    }

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl),
    })

    const walletClient = createWalletClient({
      chain: arbitrum,
      transport: http(rpcUrl),
      account,
    })

    console.log('Getting contract addresses...')
    // Get the Patcher address from deployments
    const patcherAddress = deploymentsArbitrum.Patcher
    if (
      !patcherAddress ||
      patcherAddress === '0x0000000000000000000000000000000000000000'
    ) {
      throw new Error(
        'Patcher address not found in deployments or is zero address'
      )
    }
    console.log('Patcher address:', patcherAddress)

    const baseValuePlaceholder = '1000000000000000000'
    const doubledValuePlaceholder = '2000000000000000000'

    const originalTokenOwner = account.address
    // Use the correct Arbitrum chain ID
    const chainId = 42161 // Arbitrum One

    // Define token information for Arbitrum
    console.log('Setting up token information for Arbitrum...')
    const fromToken = {
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as `0x${string}`, // WETH on Arbitrum
      decimals: 18,
    }

    const toToken = {
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`, // USDC on Arbitrum
      decimals: 6,
    }

    // Calculate CoW Shed proxy address
    console.log('Calculating CoW Shed proxy address...')
    const shedProxyAddress = await calculateCowShedProxyAddress(
      chainId,
      originalTokenOwner
    )
    console.log('Shed proxy address:', shedProxyAddress)

    // Define transaction intents
    console.log('Defining transaction intents...')
    const transactionIntents: readonly TransactionIntent[] = [
      {
        type: 'dynamicValue',
        patcherAddress: patcherAddress as `0x${string}`,
        valueSource: toToken.address,
        valueGetter: encodeBalanceOfCall(shedProxyAddress),
        targetAddress: patcherAddress as `0x${string}`,
        callDataToPatch: encodeFunctionData({
          abi: DUMMY_TARGET_ABI,
          functionName: 'deposit',
          args: [toToken.address, BigInt(baseValuePlaceholder), true],
        }),
        valueToReplace: baseValuePlaceholder,
        nativeValue: BigInt(0),
      },
      {
        type: 'multiPatch',
        patcherAddress: patcherAddress as `0x${string}`,
        targetAddress: patcherAddress as `0x${string}`,
        callDataToPatch: encodeFunctionData({
          abi: DUMMY_TARGET_ABI,
          functionName: 'multiDeposit',
          args: [
            toToken.address,
            BigInt(baseValuePlaceholder),
            BigInt(doubledValuePlaceholder),
            true,
          ],
        }),
        patchOperations: [
          {
            valueSource: toToken.address,
            valueGetter: encodeBalanceOfCall(shedProxyAddress),
            valueToReplace: baseValuePlaceholder,
          },
          {
            valueSource: patcherAddress as `0x${string}`,
            valueGetter: encodeGetDoubledBalanceCall(
              toToken.address as string,
              shedProxyAddress
            ),
            valueToReplace: doubledValuePlaceholder,
          },
        ],
        nativeValue: BigInt(0),
      },
      {
        type: 'dynamicValue',
        patcherAddress: patcherAddress as `0x${string}`,
        valueSource: toToken.address,
        valueGetter: encodeBalanceOfCall(shedProxyAddress),
        targetAddress: toToken.address,
        callDataToPatch: encodeTransferCall(
          originalTokenOwner,
          baseValuePlaceholder
        ),
        valueToReplace: baseValuePlaceholder,
        nativeValue: BigInt(0),
      },
    ]

    logKeyValue('Patcher Address', patcherAddress)
    logKeyValue('From Token', fromToken.address)
    logKeyValue('To Token', toToken.address)

    // Process transaction intents
    console.log('Processing transaction intents...')
    const processedIntents = transactionIntents.map((intent, index) => {
      logSectionHeader(`Processing intent ${index + 1} (type: ${intent.type})`)
      return processTransactionIntent(intent, true)
    })

    // Check for any errors in the processed intents
    console.log('Checking for errors in processed intents...')
    const errorResult = processedIntents.find(
      (result) => result._type === 'Left'
    )
    if (errorResult && errorResult._type === 'Left') {
      return errorResult
    }

    // Extract the successful calls
    console.log('Extracting successful calls...')
    const calls = processedIntents
      .filter(
        (result): result is { readonly _type: 'Right'; readonly data: ICall } =>
          result._type === 'Right'
      )
      .map((result) => result.data)

    // Setup post hooks for CoW Shed
    console.log('Setting up post hooks for CoW Shed...')
    const setupResult = await setupCowShedPostHooks(
      chainId,
      walletClient,
      calls,
      true
    )

    const { shedDeterministicAddress, postHooks } = setupResult

    // Amount to swap (for example, 0.1 token)
    console.log('Calculating swap amount...')
    const fromAmount = parseUnits('0.001', fromToken.decimals)

    logSectionHeader('Creating CoW Swap Order')
    logKeyValue('From Token', fromToken.address)
    logKeyValue('To Token', toToken.address)
    logKeyValue('Amount', fromAmount.toString())
    logKeyValue('Token Receiver', shedProxyAddress)
    logKeyValue('Post-hook receiver', shedDeterministicAddress)

    // Log the original post hooks
    console.log('Original post hooks:')
    postHooks.forEach((hook, index) => {
      console.log(`Original hook ${index + 1} target: ${hook.target}`)
      console.log(`Original hook ${index + 1} calldata: ${hook.callData}`)
      console.log(
        `Original hook ${index + 1} calldata length: ${
          hook.callData.length
        } bytes`
      )
    })

    // Execute the CoW Protocol flow
    console.log('Executing CoW Protocol flow...')
    const cowHashResult = await cowFlow(
      chainId,
      walletClient,
      fromToken,
      toToken,
      fromAmount,
      shedProxyAddress,
      [],
      [...postHooks]
    )

    if (cowHashResult._type === 'Left') {
      return cowHashResult
    }

    const orderHash = cowHashResult.data

    logSectionHeader('CoW Swap Order Created')
    logSuccess('Order submitted successfully')
    logKeyValue('Order hash', orderHash)
    logKeyValue(
      'Explorer URL',
      `https://explorer.cow.fi/orders/${orderHash}?chainId=${chainId}`
    )

    return right(
      `Patcher integrated with CoW Protocol - Order created with hash: ${orderHash}`
    )
  } catch (error) {
    console.error('Error in demoPatcher:', error)
    return left(
      new Error(
        `Failed to execute patcher demo: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    )
  }
}

async function main() {
  try {
    const result = await demoPatcher()
    if (result && result._type === 'Left') {
      console.error(
        `Error: ${result.error ? result.error.message : 'Unknown error'}`
      )
      process.exit(1)
    } else if (result && result._type === 'Right') {
      console.log(result.data)
      process.exit(0)
    } else {
      console.error('Unexpected result format')
      process.exit(1)
    }
  } catch (error) {
    console.error('Unexpected error:', error)
    process.exit(1)
  }
}

// Run the script
main()
