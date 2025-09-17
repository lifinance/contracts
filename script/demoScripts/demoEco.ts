/**
 * Demo script for Eco Protocol bridge integration
 *
 * This script demonstrates how to use the EcoFacet to bridge tokens
 * across chains using the Eco Protocol.
 *
 * Key updates (Sep 2025):
 * - Updated EcoData structure to match latest contract implementation
 * - Removed obsolete fields: receivingAssetId, salt, destinationInbox, destinationCalls
 * - Added encodedRoute field which contains routing information for the bridge
 * - Added proper TypeScript types from typechain
 */

// Sample TXS:
// Swap WETH -> USDC (OP -> Base) https://app.blocksec.com/explorer/tx/optimism/0xce0eff867211f9061ff04406c7d736bc9e0bda041529176b3bd04a93539d8c25
// USDC (OP -> BASE) https://app.blocksec.com/explorer/tx/optimism/0x0ece7526443b31b13b93c4005f2ad78e295aa29183e9544dd6be241882a1cc7f
// USDC (OP -> Solana) https://app.blocksec.com/explorer/tx/optimism/0x74dc04f387a10abef41f790e4110ad4562b9db97fb708ef3d2b1a337dbfd35e5

import { randomBytes } from 'crypto'

import { Keypair } from '@solana/web3.js'
import { defineCommand, runMain } from 'citty'
import { config } from 'dotenv'
import { parseUnits, zeroAddress, type Narrow, toHex } from 'viem'
import { erc20Abi } from 'viem'

import ecoFacetArtifact from '../../out/EcoFacet.sol/EcoFacet.json'
import type { ILiFi } from '../../typechain'
import type { EcoFacet, LibSwap } from '../../typechain/EcoFacet'
import type { SupportedChain } from '../common/types'

import {
  ADDRESS_USDC_OPT,
  ADDRESS_USDC_BASE,
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_ETH,
  ADDRESS_USDC_POL,
  ADDRESS_USDC_SOL,
  ADDRESS_WETH_OPT,
  ADDRESS_WETH_ARB,
  ADDRESS_WETH_ETH,
  ADDRESS_WETH_POL,
  ADDRESS_WETH_BASE,
  ADDRESS_UNISWAP_OPT,
  ADDRESS_UNISWAP_ARB,
  ADDRESS_UNISWAP_ETH,
  ADDRESS_UNISWAP_POL,
  ADDRESS_UNISWAP_BSC,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
  getUniswapDataERC20toExactERC20,
} from './utils/demoScriptHelpers'

config()

// #region ABIs
const ECO_FACET_ABI = ecoFacetArtifact.abi as Narrow<
  typeof ecoFacetArtifact.abi
>
// #endregion

// LiFi non-EVM chain IDs (matching LiFiData.sol)
// These constants are reserved for future support of non-EVM chains
// They match the chain ID mappings in the EcoFacet contract
// const LIFI_CHAIN_ID_TRON = 1885080386571452n
const LIFI_CHAIN_ID_SOLANA = 1151111081099710n

// NON_EVM_ADDRESS constant from LiFiData.sol
const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'

// Chain IDs mapping
const CHAIN_IDS: Record<string, number | bigint> = {
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
  ethereum: 1,
  polygon: 137,
  solana: LIFI_CHAIN_ID_SOLANA, // LiFi's Solana chain ID
}

// Token addresses per chain
const USDC_ADDRESSES: Record<string, string> = {
  optimism: ADDRESS_USDC_OPT,
  base: ADDRESS_USDC_BASE,
  arbitrum: ADDRESS_USDC_ARB,
  ethereum: ADDRESS_USDC_ETH,
  polygon: ADDRESS_USDC_POL,
  solana: ADDRESS_USDC_SOL, // USDC on Solana (base58)
}

// WETH addresses per chain
const WETH_ADDRESSES: Record<string, string> = {
  optimism: ADDRESS_WETH_OPT,
  base: ADDRESS_WETH_BASE,
  arbitrum: ADDRESS_WETH_ARB,
  ethereum: ADDRESS_WETH_ETH,
  polygon: ADDRESS_WETH_POL,
}

// Uniswap V2 Router addresses per chain
const UNISWAP_ADDRESSES: Record<string, string> = {
  optimism: ADDRESS_UNISWAP_OPT,
  base: ADDRESS_UNISWAP_BSC, // Uniswap V2 on Base (same as BSC address)
  arbitrum: ADDRESS_UNISWAP_ARB,
  ethereum: ADDRESS_UNISWAP_ETH,
  polygon: ADDRESS_UNISWAP_POL,
}

// Eco API configuration
const ECO_API_URL = process.env.ECO_API_URL || 'https://quotes-preprod.eco.com'
const DAPP_ID = process.env.ECO_DAPP_ID || 'lifi-demo'

console.log('Eco API Configuration:')
console.log('  API URL:', ECO_API_URL)
console.log('  DAPP ID:', DAPP_ID)
console.log('  Set ECO_API_URL and ECO_DAPP_ID env vars to override defaults\n')

/**
 * Derives a Solana address from an Ethereum private key
 * Uses the Ethereum private key as a seed for Ed25519 keypair generation
 *
 * @param ethPrivateKey - Ethereum private key (with or without 0x prefix)
 * @returns Solana address in base58 format
 */
function deriveSolanaAddress(ethPrivateKey: string): string {
  // Remove '0x' prefix if present
  const seed = ethPrivateKey.replace('0x', '')

  // Use first 32 bytes (64 hex chars) of the private key as seed for Ed25519
  const seedBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++)
    seedBytes[i] = parseInt(seed.slice(i * 2, i * 2 + 2), 16)

  // Create Solana keypair from seed
  const keypair = Keypair.fromSeed(seedBytes)

  return keypair.publicKey.toBase58()
}

/**
 * Checks if a chain is Solana
 */
function isSolanaChain(chain: string): boolean {
  return chain.toLowerCase() === 'solana'
}

interface IEcoQuoteRequest {
  dAppID: string
  quoteRequest: {
    sourceChainID: number
    destinationChainID: number
    sourceToken: string
    destinationToken: string
    sourceAmount: string
    funder: string
    refundRecipient: string
    recipient: string
  }
  contracts?: {
    sourcePortal?: string
    destinationPortal?: string
    prover?: string
  }
}

interface IEcoQuoteResponse {
  data: {
    quoteResponse: {
      sourceChainID: number
      destinationChainID: number
      sourceToken: string
      destinationToken: string
      sourceAmount: string
      destinationAmount: string
      funder: string
      refundRecipient: string
      recipient: string
      fees: Array<{
        name: string
        description: string
        token: {
          address: string
          decimals: number
          symbol: string
        }
        amount: string
      }>
      deadline: number
      estimatedFulfillTimeSec: number
      // Optional route field that may be returned by the API
      encodedRoute?: string
    }
    contracts: {
      sourcePortal: string
      destinationPortal: string
      prover: string
    }
  }
}

/**
 * Gets or generates the encoded route information for the Eco protocol
 *
 * The encodedRoute field contains the routing information needed by Eco protocol
 * to execute the cross-chain transfer. The exact binary format is defined by the
 * Eco protocol specification.
 *
 * @param quote - The quote response from Eco API
 * @param receiverAddress - The address that will receive tokens on destination chain
 * @returns Encoded route as hex string
 */
function getEncodedRoute(
  quote: IEcoQuoteResponse,
  receiverAddress: string
): `0x${string}` {
  // First, check if the API response already includes an encoded route
  if (quote.data.quoteResponse.encodedRoute) {
    console.log('Using encodedRoute from API response')
    // Ensure it starts with 0x
    const route = quote.data.quoteResponse.encodedRoute
    return route.startsWith('0x')
      ? (route as `0x${string}`)
      : (`0x${route}` as `0x${string}`)
  }

  // If no route provided by API, we need to construct one
  // The exact format depends on Eco protocol specification
  console.warn('⚠️  No encodedRoute in API response. Using placeholder.')
  console.warn('⚠️  For production use, the encodedRoute should be:')
  console.warn('    1. Obtained from the Eco API quote response')
  console.warn('    2. Constructed according to Eco protocol specification')
  console.warn('    3. Generated using an Eco protocol SDK')

  console.log('Quote details:')
  console.log('  Source chain:', quote.data.quoteResponse.sourceChainID)
  console.log(
    '  Destination chain:',
    quote.data.quoteResponse.destinationChainID
  )
  console.log('  Receiver address:', receiverAddress)

  // Using a minimal non-empty hex string as placeholder
  // This ensures the contract won't revert with InvalidConfig error
  // In production, this must be replaced with proper route encoding
  const placeholderRoute = '0x01'

  return placeholderRoute as `0x${string}`
}

async function getEcoQuote(
  sourceChain: string,
  destinationChain: string,
  amount: bigint,
  signerAddress: string,
  privateKey?: string
): Promise<IEcoQuoteResponse> {
  const sourceChainId = CHAIN_IDS[sourceChain]
  const destinationChainId = CHAIN_IDS[destinationChain]
  const sourceToken = USDC_ADDRESSES[sourceChain]
  const destinationToken = USDC_ADDRESSES[destinationChain]

  if (!sourceChainId || !destinationChainId)
    throw new Error(`Unsupported chain: ${sourceChain} or ${destinationChain}`)

  if (!sourceToken || !destinationToken)
    throw new Error(
      `USDC address not found for chain: ${sourceChain} or ${destinationChain}`
    )

  // Determine the recipient address based on destination chain
  let recipientAddress = signerAddress
  if (isSolanaChain(destinationChain)) {
    if (!privateKey)
      throw new Error('Private key required for Solana destination')

    recipientAddress = deriveSolanaAddress(privateKey)
    console.log('Derived Solana recipient address:', recipientAddress)
  }

  // Convert chain IDs to number for API (Eco API expects number)
  const sourceChainIdNum =
    typeof sourceChainId === 'bigint' ? Number(sourceChainId) : sourceChainId
  const destChainIdNum =
    typeof destinationChainId === 'bigint'
      ? destinationChain === 'solana'
        ? 1399811149
        : Number(destinationChainId)
      : destinationChainId

  const quoteRequest: IEcoQuoteRequest = {
    dAppID: DAPP_ID,
    quoteRequest: {
      sourceChainID: sourceChainIdNum,
      destinationChainID: destChainIdNum,
      sourceToken,
      destinationToken,
      sourceAmount: amount.toString(),
      funder: signerAddress,
      refundRecipient: signerAddress,
      recipient: recipientAddress,
    },
  }

  console.log('Fetching quote from Eco API...')
  console.log('Quote request:', JSON.stringify(quoteRequest, null, 2))

  const response = await fetch(`${ECO_API_URL}/api/v3/quotes/getQuote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(quoteRequest),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to get quote: ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  console.log('Quote received:', JSON.stringify(data, null, 2))

  // Check for error in response
  if (data.error) {
    console.error('API returned error:', data.error)
    throw new Error(`Eco API error: ${data.error.message || data.error}`)
  }

  // Validate the response structure
  if (!data || !data.data || !data.data.quoteResponse) {
    console.error('Invalid quote response structure.')
    console.error('Expected structure with data.quoteResponse, but got:', data)

    // Provide helpful debugging information
    if (Object.keys(data).length === 0)
      throw new Error(
        'Eco API returned an empty response. Possible issues:\n' +
          '1. The API endpoint might be down or changed\n' +
          '2. The DAPP_ID might be invalid\n' +
          '3. The route from Optimism to Base might not be supported\n' +
          'Try setting ECO_API_URL and ECO_DAPP_ID environment variables if you have different values.'
      )

    throw new Error(
      'Invalid quote response from Eco API. The API response format might have changed.'
    )
  }

  return data as IEcoQuoteResponse
}

async function main(args: {
  srcChain: SupportedChain
  dstChain: string
  amount: string
  swap?: boolean
}) {
  // === Set up environment ===
  const srcChain = args.srcChain
  const withSwap = args.swap || false

  const { publicClient, walletAccount, walletClient, lifiDiamondContract } =
    await setupEnvironment(srcChain, ECO_FACET_ABI)
  const signerAddress = walletAccount.address

  if (!lifiDiamondContract || !lifiDiamondContract.address)
    throw new Error('LiFi Diamond contract not found')

  console.info(
    `Bridge ${args.amount} USDC from ${srcChain} --> ${args.dstChain}${
      withSwap ? ' (with WETH -> USDC swap)' : ''
    }`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  // Get the private key from env for Solana derivation if needed
  const privateKey = process.env.PRIVATE_KEY

  // === Get quote from Eco API ===
  const amount = parseUnits(args.amount, 6) // USDC has 6 decimals
  const quote = await getEcoQuote(
    srcChain,
    args.dstChain,
    amount,
    signerAddress,
    privateKey
  )

  // Extract fee amount from quote
  const protocolFee = quote.data.quoteResponse.fees.find(
    (f) => f.name === 'Eco Protocol Fee'
  )
  if (!protocolFee) throw new Error('No protocol fee found in quote')

  const feeAmount = BigInt(protocolFee.amount)

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = USDC_ADDRESSES[srcChain] as `0x${string}`
  const WETH_ADDRESS = WETH_ADDRESSES[srcChain] as `0x${string}`
  const UNISWAP_ADDRESS = UNISWAP_ADDRESSES[srcChain] as `0x${string}`

  // === Prepare swap data if needed ===
  let swapData: LibSwap.SwapDataStruct[] = []
  let inputAmount = amount + feeAmount
  let inputTokenAddress = SRC_TOKEN_ADDRESS

  if (withSwap) {
    if (!WETH_ADDRESSES[srcChain])
      throw new Error(`WETH address not configured for ${srcChain}`)

    if (!UNISWAP_ADDRESSES[srcChain])
      throw new Error(`Uniswap address not configured for ${srcChain}`)

    console.log('\n🔄 Preparing swap data (WETH -> USDC)...')

    // Get chain ID for current chain
    const chainId = Number((await publicClient.getChainId()).toString())

    // Import BigNumber from ethers for compatibility
    const { BigNumber } = await import('ethers')

    // The contract needs minAmount + solverReward after the swap
    // So we need to swap to get exactly that amount
    const requiredSwapOutput = amount + feeAmount // This will be minAmount + solverReward

    // Use the helper to calculate exact input for exact output
    const swapDataItem = await getUniswapDataERC20toExactERC20(
      UNISWAP_ADDRESS,
      chainId,
      WETH_ADDRESS,
      SRC_TOKEN_ADDRESS,
      BigNumber.from(requiredSwapOutput.toString()), // Exact USDC output we need
      lifiDiamondContract.address,
      true, // requiresDeposit
      Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour deadline
    )

    swapData = [swapDataItem]
    inputAmount = BigInt(swapDataItem.fromAmount.toString()) // The amount of WETH needed (with slippage)
    inputTokenAddress = WETH_ADDRESS

    console.log(
      `Swap prepared: ${parseFloat(
        (inputAmount / 10n ** 18n).toString()
      ).toFixed(6)} WETH (max with slippage) -> ${(
        requiredSwapOutput /
        10n ** 6n
      ).toString()} USDC (exact)`
    )
  }

  // Ensure wallet has sufficient balance (WETH for swap, USDC for direct bridge)
  const inputTokenContract = {
    read: {
      balanceOf: async (args: [`0x${string}`]): Promise<bigint> => {
        return (await publicClient.readContract({
          address: inputTokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args,
        })) as bigint
      },
    },
  } as const

  await ensureBalance(
    inputTokenContract,
    signerAddress,
    inputAmount,
    publicClient
  )

  // === Prepare bridge data ===
  const isDestinationSolana = isSolanaChain(args.dstChain)

  // Determine the receiver address and destination chain ID
  let receiverAddress = signerAddress
  let destinationChainId: bigint

  if (isDestinationSolana) {
    // For Solana, use NON_EVM_ADDRESS as receiver in bridge data
    receiverAddress = NON_EVM_ADDRESS as `0x${string}`
    destinationChainId = LIFI_CHAIN_ID_SOLANA
  } else
    destinationChainId = BigInt(quote.data.quoteResponse.destinationChainID)

  // When NOT swapping: minAmount should be the actual bridge amount (without fee)
  // When swapping: The contract flow is:
  //   1. _depositAndSwap checks swap produces at least minAmount
  //   2. If ERC20, contract subtracts solverReward from swap result
  //   3. _startBridge then adds solverReward back for the portal
  // So when swapping, minAmount should be (amount + feeAmount) so that
  // after subtracting feeAmount, we have the correct amount for the bridge
  const bridgeMinAmount = withSwap ? amount + feeAmount : amount

  // When swapping, sendingAssetId should be the OUTPUT token (USDC), not the input token
  // This is because after the swap, the contract works with USDC
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'eco',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS, // Always USDC - the token we're actually bridging
    receiver: receiverAddress,
    destinationChainId: destinationChainId,
    minAmount: bridgeMinAmount,
    hasSourceSwaps: withSwap,
    hasDestinationCall: false,
  }

  // === Prepare EcoData ===
  // Get the actual recipient address (Solana or EVM)
  let actualRecipientAddress = signerAddress
  let nonEVMReceiverBytes = '0x' as `0x${string}`

  if (isDestinationSolana) {
    if (!privateKey)
      throw new Error('Private key required for Solana destination')

    const solanaAddress = deriveSolanaAddress(privateKey)
    // Convert Solana base58 address to hex bytes for nonEVMReceiver field
    const encoder = new TextEncoder()
    const solanaAddressBytes = encoder.encode(solanaAddress)
    nonEVMReceiverBytes = toHex(solanaAddressBytes)
    actualRecipientAddress = signerAddress // Keep EVM address for validation

    console.log('Solana destination details:')
    console.log('  Solana recipient:', solanaAddress)
    console.log('  Encoded as bytes:', nonEVMReceiverBytes)
  }

  // For the encodedRoute, we need to encode the destination information
  // The actual format depends on Eco protocol requirements
  // For now, we'll encode basic route information
  const encodedRoute = getEncodedRoute(quote, actualRecipientAddress)

  const ecoData: EcoFacet.EcoDataStruct = {
    receiverAddress: actualRecipientAddress, // EVM address for validation
    nonEVMReceiver: nonEVMReceiverBytes, // Solana address as bytes or '0x' for EVM
    prover: quote.data.contracts.prover, // Prover address from quote
    rewardDeadline: BigInt(quote.data.quoteResponse.deadline), // Deadline from quote
    solverReward: feeAmount, // Solver fee from quote
    encodedRoute: encodedRoute, // Encoded route information for the bridge
  }

  // === Ensure allowance ===
  const tokenContract = {
    read: {
      allowance: async (
        args: [`0x${string}`, `0x${string}`]
      ): Promise<bigint> => {
        return (await publicClient.readContract({
          address: inputTokenAddress,
          abi: erc20Abi,
          functionName: 'allowance',
          args,
        })) as bigint
      },
    },
    write: {
      approve: async (
        args: [`0x${string}`, bigint]
      ): Promise<`0x${string}`> => {
        return walletClient.writeContract({
          address: inputTokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args,
        } as any)
      },
    },
  }

  await ensureAllowance(
    tokenContract,
    signerAddress as `0x${string}`,
    lifiDiamondContract.address,
    inputAmount, // Approve the input amount (WETH if swapping, USDC if not)
    publicClient
  )

  // === Start bridging ===
  console.log('Transaction details:')
  console.log('  Mode:', withSwap ? 'Swap and Bridge' : 'Bridge only')
  console.log('  Source chain:', srcChain)
  console.log('  Destination chain:', args.dstChain)
  if (withSwap) {
    console.log('  Input token: WETH')
    console.log(
      '  Input amount:',
      (inputAmount / 10n ** 18n).toString(),
      'WETH (max with slippage)'
    )
    console.log(
      '  Swap output:',
      (amount + feeAmount).toString(),
      'USDC (including fee)'
    )
    console.log('  Bridge amount after fee:', amount.toString(), 'USDC')
  } else console.log('  Source amount:', amount.toString(), 'USDC')

  console.log(
    '  Destination amount:',
    quote.data.quoteResponse.destinationAmount
  )
  console.log('  Protocol fee:', ecoData.solverReward.toString())
  console.log(
    '  Estimated fulfillment time:',
    quote.data.quoteResponse.estimatedFulfillTimeSec,
    'seconds'
  )
  console.log('  Prover address:', ecoData.prover)
  console.log(
    '  Reward deadline:',
    new Date(Number(ecoData.rewardDeadline) * 1000).toISOString()
  )

  if (isDestinationSolana) {
    console.log('\nSolana-specific details:')
    console.log(
      '  Destination chain ID (LiFi):',
      LIFI_CHAIN_ID_SOLANA.toString()
    )
    console.log('  Destination chain ID (Eco):', '1399811149')
    if (privateKey)
      console.log('  Solana recipient:', deriveSolanaAddress(privateKey))
  }

  console.log('\nBridge data:', bridgeData)
  console.log('\nEco data (updated structure):')
  console.log('  - receiverAddress:', ecoData.receiverAddress)
  console.log('  - nonEVMReceiver:', ecoData.nonEVMReceiver)
  console.log('  - prover:', ecoData.prover)
  console.log('  - rewardDeadline:', ecoData.rewardDeadline.toString())
  console.log('  - solverReward:', ecoData.solverReward.toString())
  console.log(
    '  - encodedRoute length:',
    (ecoData.encodedRoute as string).length,
    'chars'
  )

  await executeTransaction(
    () =>
      withSwap
        ? walletClient.writeContract({
            address: lifiDiamondContract.address,
            abi: ECO_FACET_ABI,
            functionName: 'swapAndStartBridgeTokensViaEco',
            args: [bridgeData, swapData, ecoData],
            // No value needed - fee is paid in USDC
          })
        : walletClient.writeContract({
            address: lifiDiamondContract.address,
            abi: ECO_FACET_ABI,
            functionName: 'startBridgeTokensViaEco',
            args: [bridgeData, ecoData],
            // No value needed - fee is paid in USDC
          }),
    withSwap
      ? 'Swapping WETH to USDC and starting bridge via Eco'
      : 'Starting bridge tokens via Eco',
    publicClient,
    true
  )
}

const command = defineCommand({
  meta: {
    name: 'demoEco',
    description: 'Demo script for bridging tokens via Eco Protocol',
  },
  args: {
    srcChain: {
      type: 'string',
      default: 'optimism',
      description: 'Source chain for the bridge (e.g., optimism)',
    },
    dstChain: {
      type: 'string',
      default: 'base',
      description: 'Destination chain for the bridge (e.g., base)',
    },
    amount: {
      type: 'string',
      default: '5',
      description: 'Amount of USDC to bridge',
    },
    swap: {
      type: 'boolean',
      default: false,
      description: 'Perform a WETH -> USDC swap before bridging',
    },
  },
  async run({ args }) {
    await main({
      srcChain: args.srcChain as SupportedChain,
      dstChain: args.dstChain,
      amount: args.amount,
      swap: args.swap,
    })
  },
})

runMain(command)
