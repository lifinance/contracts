/// ==== SUCCESS TXs ====
// Bridge USDC: Arbitrum → Solana
// src: https://arbiscan.io/tx/0x5dc9f72fc5d61d3023755465d1d68d8917410e67c9dcdbd13b1059eb6341ea56
// dst: https://solscan.io/tx/44EfSioHRApBAAcjQfGM2SNtXEczNocrqZbxjW5CwCcCjb3okhBeVc8635Jy3n1xsqqRfbgz6UoB9y7uXuyEbNup
// Swap USDT→USDC and bridge: Arbitrum → Solana
// src: https://arbiscan.io/tx/0x43378460863db76ee5ad96e93727c3e0c6cefd839f1daa8924a1eaef067f410e
// dst: https://solscan.io/tx/4oUbFCxHByLg7HbeJwfZMkF36ZRokRZYR21qg6WdYMChPNVaQbw22XnWaxKrn7RtHhgvjukXSNwzpdHWTKR5sDHi
// Bridge USDC: Arbitrum → Base
// src: https://arbiscan.io/tx/0x865ad42ab96d2e8e5ad742704c134def6f61982a2c42e5248c661a889389e054
// dst: https://basescan.org/tx/0xdbebd74aea9defd492ed82c67e24b9d0b5e30dac0328ffbfd41e3174b0bd9797

import { randomBytes } from 'crypto'

import { Keypair } from '@solana/web3.js'
// @ts-expect-error - bs58 types not available
// eslint-disable-next-line import/no-extraneous-dependencies -- bs58 is available via @layerzerolabs/lz-v2-utilities
import { decode as decodeBase58 } from 'bs58'
import { runMain, defineCommand } from 'citty'
import { config } from 'dotenv'
import { BigNumber } from 'ethers'
import {
  zeroAddress,
  toHex,
  parseUnits,
  formatUnits,
  parseAbi,
  getContract,
  type Abi,
} from 'viem'

import nearIntentsFacetArtifact from '../../out/NEARIntentsFacet.sol/NEARIntentsFacet.json'
import type { ILiFi } from '../../typechain'
import type { LibSwap } from '../../typechain/AcrossFacetV3'
import type { SupportedChain } from '../common/types'
import { networks } from '../utils/viemScriptHelpers'

import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
  ADDRESS_USDC_ARB,
  ADDRESS_USDT_ARB,
  ADDRESS_UNISWAP_ARB,
  getUniswapDataERC20toExactERC20,
} from './utils/demoScriptHelpers'

config()

// NEARIntentsFacet types (for demo purposes, since typechain may not be generated yet)
// eslint-disable-next-line @typescript-eslint/no-namespace -- Using namespace for type organization
declare namespace NEARIntentsFacet {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Matches Solidity struct name
  interface NEARIntentsDataStruct {
    quoteId: `0x${string}`
    depositAddress: string
    deadline: bigint
    minAmountOut: bigint
    nonEVMReceiver: `0x${string}`
    signature: `0x${string}`
  }
}

// Constants
const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'
const LIFI_CHAIN_ID_SOLANA = 1151111081099710n

// Fixed chains for demo
const SOURCE_CHAIN: SupportedChain = 'arbitrum' // Always Arbitrum
const DEST_CHAIN_EVM: SupportedChain = 'base' // Base for EVM-to-EVM
const DEST_CHAIN_SOLANA = 'solana' // Solana for EVM-to-Solana

/// ========== TYPE DEFINITIONS ========== ///

// Based on NEAR Intents 1-Click API documentation
interface INEARIntentsQuoteRequest {
  dry: boolean
  depositMode: 'SIMPLE' | 'MEMO'
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT'
  slippageTolerance: number
  originAsset: string
  depositType: 'ORIGIN_CHAIN' | 'INTENTS'
  destinationAsset: string
  amount: string
  refundTo: string
  refundType: 'ORIGIN_CHAIN' | 'INTENTS'
  recipient: string
  recipientType: 'DESTINATION_CHAIN' | 'INTENTS'
  deadline: string
  referral?: string
  quoteWaitingTimeMs?: number
}

interface INEARIntentsQuote {
  depositAddress: string
  depositMemo?: string
  amountIn: string
  amountInFormatted: string
  amountInUsd: string
  minAmountIn?: string
  amountOut: string
  amountOutFormatted: string
  amountOutUsd: string
  minAmountOut: string
  deadline: string
  timeWhenInactive: string
  timeEstimate: number
}

interface INEARIntentsQuoteResponse {
  timestamp: string
  signature: string
  quoteRequest: INEARIntentsQuoteRequest
  quote: INEARIntentsQuote
}

/// ========== HELPER FUNCTIONS ========== ///

/**
 * Derives a Solana address from an Ethereum private key
 * Uses the Ethereum private key as a seed for Ed25519 keypair generation
 * This allows the same private key to control funds on both EVM and Solana chains
 *
 * @param ethPrivateKey - Ethereum private key (with or without 0x prefix)
 * @returns Solana address in base58 format
 */
function deriveSolanaAddress(ethPrivateKey: string): string {
  console.log('\n🔑 Deriving Solana address from EVM private key...')

  // Remove '0x' prefix if present
  const seed = ethPrivateKey.replace('0x', '')

  // Use first 32 bytes (64 hex chars) of the private key as seed for Ed25519
  const seedBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    seedBytes[i] = parseInt(seed.slice(i * 2, i * 2 + 2), 16)
  }

  // Create Solana keypair from seed
  const keypair = Keypair.fromSeed(seedBytes)
  const solanaAddress = keypair.publicKey.toBase58()

  console.log('  ✅ Derived Solana address:', solanaAddress)

  return solanaAddress
}

/**
 * Converts a Solana base58 address to bytes32 for non-EVM address field
 * Solana addresses are 32-byte Ed25519 public keys encoded in base58
 */
function solanaAddressToBytes32(solanaAddress: string): `0x${string}` {
  console.log(`\n📝 Converting Solana address to bytes32...`)
  console.log('  Solana address (base58):', solanaAddress)

  try {
    // Decode base58 to get raw 32 bytes
    const addressBytes = decodeBase58(solanaAddress)

    if (addressBytes.length !== 32) {
      throw new Error(
        `Invalid Solana address length: ${addressBytes.length} bytes (expected 32)`
      )
    }

    // Convert to hex string
    const hexAddress = toHex(addressBytes)
    console.log('  Encoded as bytes32:', hexAddress)

    return hexAddress
  } catch (error) {
    throw new Error(
      `Failed to convert Solana address: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    )
  }
}

/**
 * Fetches a quote from the NEAR Intents 1-Click API
 */
async function fetchNEARIntentsQuote(
  request: INEARIntentsQuoteRequest
): Promise<INEARIntentsQuoteResponse> {
  const apiUrl = 'https://1click.chaindefuser.com/v0/quote'

  console.log('Fetching quote from NEAR Intents 1-Click API...')
  console.log('Request:', JSON.stringify(request, null, 2))

  // Use JWT token if available (optional, reduces fees)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (process.env.NEAR_INTENTS_JWT) {
    headers['Authorization'] = `Bearer ${process.env.NEAR_INTENTS_JWT}`
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API request failed: ${response.statusText}\n${errorText}`)
  }

  const quoteResponse: INEARIntentsQuoteResponse = await response.json()
  console.log('\n✅ Received quote from NEAR Intents:')
  console.log('  Deposit Address:', quoteResponse.quote.depositAddress)
  console.log('  Amount In:', quoteResponse.quote.amountInFormatted)
  console.log('  Amount Out:', quoteResponse.quote.amountOutFormatted)
  console.log('  Time Estimate:', quoteResponse.quote.timeEstimate, 'seconds')
  console.log('  Deadline:', quoteResponse.quote.deadline)

  return quoteResponse
}

/**
 * Generates backend EIP-712 signature for NEARIntentsFacet
 */
async function generateBackendSignature(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walletAccount type from viem
  walletAccount: any,
  lifiDiamondAddress: `0x${string}`,
  bridgeData: ILiFi.BridgeDataStruct,
  nearData: {
    quoteId: `0x${string}`
    depositAddress: string
    deadline: bigint
    minAmountOut: bigint
    nonEVMReceiver: `0x${string}`
  },
  sourceChainId: number
): Promise<`0x${string}`> {
  console.log('\n🔏 Backend EIP-712 signing...')
  // on staging, we use dev wallet account to sign the data
  // the facet BACKEND_SIGNER in this case has to be the same as the wallet account address

  // Domain definition - must match NEARIntentsFacet._domainSeparator()
  const domain = {
    name: 'LI.FI NEAR Intents Facet',
    version: '1',
    chainId: sourceChainId,
    verifyingContract: lifiDiamondAddress,
  } as const

  // Types definition - must match NEARINTENTS_PAYLOAD_TYPEHASH
  // CRITICAL: receiver is bytes32 to support non-EVM addresses
  const types = {
    NEARIntentsPayload: [
      { name: 'transactionId', type: 'bytes32' },
      { name: 'minAmount', type: 'uint256' },
      { name: 'receiver', type: 'bytes32' }, // bytes32, not address!
      { name: 'depositAddress', type: 'address' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'sendingAssetId', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'quoteId', type: 'bytes32' },
      { name: 'minAmountOut', type: 'uint256' },
    ],
  } as const

  // Determine receiver hash based on destination type
  const receiver = bridgeData.receiver as string
  const receiverHash =
    receiver === '0x11f111f111f111F111f111f111F111f111f111F1'
      ? nearData.nonEVMReceiver // Use nonEVMReceiver for Solana
      : (`0x${BigInt(receiver)
          .toString(16)
          .padStart(64, '0')}` as `0x${string}`) // Convert address to bytes32

  const message = {
    transactionId: bridgeData.transactionId as `0x${string}`,
    minAmount: BigInt(bridgeData.minAmount.toString()),
    receiver: receiverHash,
    depositAddress: nearData.depositAddress,
    destinationChainId: BigInt(bridgeData.destinationChainId.toString()),
    sendingAssetId: bridgeData.sendingAssetId as `0x${string}`,
    deadline: nearData.deadline,
    quoteId: nearData.quoteId,
    minAmountOut: nearData.minAmountOut,
  } as const

  console.log('Types:', types)
  console.log('Message:', message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EIP-712 message type compatibility
  const signature = await walletAccount.signTypedData({
    domain,
    types,
    primaryType: 'NEARIntentsPayload',
    message: message as any,
  })

  console.log('Generated EIP-712 Signature:', signature)
  return signature as `0x${string}`
}

/// ========== MAIN BRIDGE FUNCTIONS ========== ///

/**
 * Bridge USDC from Arbitrum to Solana
 */
async function bridgeEVMtoSolana(amountStr = '1', withSwap = false) {
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║         NEAR Intents: Arbitrum → Solana Bridge           ║')
  console.log('╚═══════════════════════════════════════════════════════════╝\n')

  // Parse amount with 6 decimals for USDC
  const amount = parseUnits(amountStr, 6)

  if (withSwap) {
    console.log(
      `📊 Swapping USDT → USDC, then bridging ${amountStr} USDC to Solana`
    )
  } else {
    console.log(`📊 Bridging ${amountStr} USDC from Arbitrum to Solana`)
  }

  // Token addresses - using imported constants
  const USDC_ARBITRUM = ADDRESS_USDC_ARB
  // Note: ADDRESS_USDC_SOL is the base58 format, but we don't need it for asset ID

  // Setup environment
  console.log('\n⚙️  Setting up environment...')
  const NEARINTENTS_FACET_ABI = nearIntentsFacetArtifact.abi as Abi
  const { client, publicClient, walletAccount, lifiDiamondContract } =
    await setupEnvironment(SOURCE_CHAIN, NEARINTENTS_FACET_ABI)

  const signerAddress = walletAccount.address
  const lifiDiamondAddress = lifiDiamondContract?.address
  const privateKey = process.env.PRIVATE_KEY

  if (!lifiDiamondAddress) {
    throw new Error('Failed to get LiFi Diamond address')
  }

  if (!privateKey) {
    throw new Error(
      'PRIVATE_KEY environment variable is required for Solana address derivation'
    )
  }

  console.log('  ✅ Connected wallet (EVM):', signerAddress)
  console.log('  ✅ LiFi Diamond:', lifiDiamondAddress)
  console.log('  ✅ Source chain:', SOURCE_CHAIN)
  console.log('  ✅ Destination chain:', DEST_CHAIN_SOLANA)
  console.log('  ✅ Amount:', formatUnits(amount, 6), 'USDC')

  // Derive Solana address from the same private key
  const solanaReceiver = deriveSolanaAddress(privateKey)
  const solanaReceiverBytes32 = solanaAddressToBytes32(solanaReceiver)

  // Get asset IDs in NEAR Intents format
  // Hardcoded asset IDs from NEAR Intents API /v0/tokens endpoint
  // Arbitrum USDC: CONTRACT=0xaf88d065e77c8cc2239327c5edb3a432268e5831
  const originAsset =
    'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
  // Solana USDC: CONTRACT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (base58)
  // Note: The asset ID uses a different hex encoding (5ce3bf3a...) than the contract address
  const destinationAsset =
    'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'

  console.log('\n💱 Asset mapping:')
  console.log('  Origin:', originAsset)
  console.log('  Destination:', destinationAsset)
  console.log('\n📍 Addresses:')
  console.log('  EVM Sender:', signerAddress)
  console.log('  Solana Receiver:', solanaReceiver)
  console.log('  Solana Receiver (bytes32):', solanaReceiverBytes32)

  // Prepare deadline (1 hour from now)
  const deadlineDate = new Date(Date.now() + 3600 * 1000)
  const deadlineISO = deadlineDate.toISOString()

  // Fetch quote from NEAR Intents API
  const quoteRequest: INEARIntentsQuoteRequest = {
    dry: false,
    depositMode: 'SIMPLE',
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100, // 1% (100 basis points)
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset,
    amount: amount.toString(),
    refundTo: signerAddress,
    refundType: 'ORIGIN_CHAIN',
    recipient: solanaReceiver,
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadlineISO,
    referral: 'lifi',
    quoteWaitingTimeMs: 3000,
  }

  const quoteResponse = await fetchNEARIntentsQuote(quoteRequest)
  const quote = quoteResponse.quote

  // Prepare swap data if needed
  let swapData: LibSwap.SwapDataStruct[] = []
  let inputAmount = amount
  let inputTokenAddress = USDC_ARBITRUM

  if (withSwap) {
    console.log('\n🔄 Preparing swap: USDT → USDC...')
    const swapDataItem = await getUniswapDataERC20toExactERC20(
      ADDRESS_UNISWAP_ARB,
      42161, // Arbitrum chain ID
      ADDRESS_USDT_ARB, // Input: USDT
      USDC_ARBITRUM, // Output: USDC
      BigNumber.from(amount.toString()), // Exact USDC output
      lifiDiamondAddress,
      true,
      Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour deadline
    )

    swapData = [swapDataItem]
    inputAmount = BigInt(swapDataItem.fromAmount.toString()) // USDT with slippage
    inputTokenAddress = ADDRESS_USDT_ARB

    console.log(
      `  Input: ${formatUnits(inputAmount, 6)} USDT (max, includes slippage)`
    )
    console.log(`  Output: ${formatUnits(amount, 6)} USDC (exact)`)
  }

  // Ensure balance and allowance
  console.log('\n💰 Checking balance and allowance...')

  // Create ERC20 contract instance for the INPUT token
  const ERC20_ABI = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ])

  const inputTokenContract = getContract({
    address: inputTokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    client,
  })

  await ensureBalance(inputTokenContract, signerAddress, inputAmount)
  await ensureAllowance(
    inputTokenContract,
    signerAddress,
    lifiDiamondAddress,
    inputAmount,
    publicClient
  )

  // Prepare transaction data
  const transactionId = `0x${randomBytes(32).toString('hex')}` as `0x${string}`

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'near-intents',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: USDC_ARBITRUM, // Always USDC (output token after swap)
    receiver: NON_EVM_ADDRESS, // Sentinel value for non-EVM
    destinationChainId: Number(LIFI_CHAIN_ID_SOLANA),
    minAmount: amount, // Exact USDC needed (pre-swap amount)
    hasSourceSwaps: withSwap,
    hasDestinationCall: false,
  }

  // Convert quote ID to bytes32
  // Use a hash of the deposit address as a unique identifier for the quote
  const crypto = await import('crypto')
  const quoteIdBytes32 = `0x${crypto
    .createHash('sha256')
    .update(quote.depositAddress)
    .digest('hex')}` as `0x${string}`

  const deadline = BigInt(Math.floor(new Date(quote.deadline).getTime() / 1000))
  const minAmountOut = BigInt(quote.minAmountOut)

  const nearDataForSigning = {
    quoteId: quoteIdBytes32,
    depositAddress: quote.depositAddress,
    deadline,
    minAmountOut,
    nonEVMReceiver: solanaReceiverBytes32,
  }

  // Generate backend signature
  const sourceChainId = networks[SOURCE_CHAIN]?.chainId
  if (!sourceChainId) {
    throw new Error(`Chain ID not found for ${SOURCE_CHAIN}`)
  }
  const signature = await generateBackendSignature(
    walletAccount,
    lifiDiamondAddress,
    bridgeData,
    nearDataForSigning,
    sourceChainId
  )

  const nearData: NEARIntentsFacet.NEARIntentsDataStruct = {
    quoteId: quoteIdBytes32,
    depositAddress: quote.depositAddress,
    deadline,
    minAmountOut,
    nonEVMReceiver: solanaReceiverBytes32,
    signature,
  }

  console.log('\n📋 Transaction Summary:')
  console.log('  Transaction ID:', bridgeData.transactionId)
  console.log('  Bridge:', bridgeData.bridge)
  console.log('  Source:', SOURCE_CHAIN)
  console.log('  Destination:', DEST_CHAIN_SOLANA)
  if (withSwap) {
    console.log('  Swap: USDT → USDC')
    console.log('  Max Input:', formatUnits(inputAmount, 6), 'USDT')
  }
  console.log('  Amount In:', formatUnits(amount, 6), 'USDC')
  console.log('  Expected Out:', quote.amountOutFormatted, 'USDC')
  console.log('  Deposit Address:', quote.depositAddress)
  console.log('  EVM Sender:', signerAddress)
  console.log('  Solana Receiver:', solanaReceiver, '(derived)')
  console.log('  Deadline:', new Date(Number(deadline) * 1000).toISOString())
  console.log('\n💡 The Solana address is derived from your EVM private key')

  // Execute transaction
  console.log('\n🚀 Executing bridge transaction...\n')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Diamond contract typing
  const txHash = await executeTransaction(
    () =>
      withSwap
        ? (
            lifiDiamondContract as any
          ).write.swapAndStartBridgeTokensViaNEARIntents([
            bridgeData,
            swapData,
            nearData,
          ])
        : (lifiDiamondContract as any).write.startBridgeTokensViaNEARIntents([
            bridgeData,
            nearData,
          ]),
    withSwap
      ? 'Swap USDT→USDC and bridge to Solana via NEAR Intents'
      : 'Bridge USDC: Arbitrum → Solana via NEAR Intents',
    publicClient,
    true
  )

  console.log('\n✅ Bridge transaction initiated successfully!')
  console.log('\n🔗 Transaction:')
  console.log(`   https://arbiscan.io/tx/${txHash}`)
  console.log('\n📊 Track swap status:')
  console.log(
    `   curl "https://1click.chaindefuser.com/v0/status?depositAddress=${quote.depositAddress}"`
  )
  console.log('\n🔗 Check balances:')
  console.log(`   Arbitrum: https://arbiscan.io/address/${signerAddress}`)
  console.log(`   Solana: https://solscan.io/account/${solanaReceiver}`)
}

/**
 * Bridge USDC from Arbitrum to Base
 */
async function bridgeEVMtoEVM(amountStr = '1', withSwap = false) {
  console.log('╔═══════════════════════════════════════════════════════════╗')
  console.log('║          NEAR Intents: Arbitrum → Base Bridge            ║')
  console.log('╚═══════════════════════════════════════════════════════════╝\n')

  // Parse amount with 6 decimals for USDC
  const amount = parseUnits(amountStr, 6)

  if (withSwap) {
    console.log(
      `📊 Swapping USDT → USDC, then bridging ${amountStr} USDC to Base`
    )
  } else {
    console.log(`📊 Bridging ${amountStr} USDC from Arbitrum to Base`)
  }

  // Use constants from demoScriptHelpers
  const USDC_ARBITRUM = ADDRESS_USDC_ARB

  console.log('\n⚙️  Setting up environment...')
  const NEARINTENTS_FACET_ABI = nearIntentsFacetArtifact.abi as Abi
  const { client, publicClient, walletAccount, lifiDiamondContract } =
    await setupEnvironment(SOURCE_CHAIN, NEARINTENTS_FACET_ABI)

  const signerAddress = walletAccount.address
  const lifiDiamondAddress = lifiDiamondContract?.address

  if (!lifiDiamondAddress) {
    throw new Error('Failed to get LiFi Diamond address')
  }

  console.log('  ✅ Connected wallet:', signerAddress)
  console.log('  ✅ Source:', SOURCE_CHAIN)
  console.log('  ✅ Destination:', DEST_CHAIN_EVM)
  console.log('  ✅ Amount:', formatUnits(amount, 6), 'USDC')

  // Hardcoded asset IDs from NEAR Intents API /v0/tokens endpoint
  // Arbitrum USDC: CONTRACT=0xaf88d065e77c8cc2239327c5edb3a432268e5831
  const originAsset =
    'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
  // Base USDC: CONTRACT=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
  const destinationAsset =
    'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'

  console.log('\n💱 Asset mapping:')
  console.log('  Origin:', originAsset)
  console.log('  Destination:', destinationAsset)

  const deadlineDate = new Date(Date.now() + 3600 * 1000)
  const deadlineISO = deadlineDate.toISOString()

  const quoteRequest: INEARIntentsQuoteRequest = {
    dry: false,
    depositMode: 'SIMPLE',
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset,
    amount: amount.toString(),
    refundTo: signerAddress,
    refundType: 'ORIGIN_CHAIN',
    recipient: signerAddress, // Same EVM address on Base
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadlineISO,
    referral: 'lifi',
    quoteWaitingTimeMs: 3000,
  }

  const quoteResponse = await fetchNEARIntentsQuote(quoteRequest)
  const quote = quoteResponse.quote

  // Prepare swap data if needed
  let swapData: LibSwap.SwapDataStruct[] = []
  let inputAmount = amount
  let inputTokenAddress = USDC_ARBITRUM

  if (withSwap) {
    console.log('\n🔄 Preparing swap: USDT → USDC...')
    const swapDataItem = await getUniswapDataERC20toExactERC20(
      ADDRESS_UNISWAP_ARB,
      42161, // Arbitrum chain ID
      ADDRESS_USDT_ARB, // Input: USDT
      USDC_ARBITRUM, // Output: USDC
      BigNumber.from(amount.toString()), // Exact USDC output
      lifiDiamondAddress,
      true,
      Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour deadline
    )

    swapData = [swapDataItem]
    inputAmount = BigInt(swapDataItem.fromAmount.toString()) // USDT with slippage
    inputTokenAddress = ADDRESS_USDT_ARB

    console.log(
      `  Input: ${formatUnits(inputAmount, 6)} USDT (max, includes slippage)`
    )
    console.log(`  Output: ${formatUnits(amount, 6)} USDC (exact)`)
  }

  // Ensure balance and allowance
  console.log('\n💰 Checking balance and allowance...')

  const ERC20_ABI = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ])

  const inputTokenContract = getContract({
    address: inputTokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    client,
  })

  await ensureBalance(inputTokenContract, signerAddress, inputAmount)
  await ensureAllowance(
    inputTokenContract,
    signerAddress,
    lifiDiamondAddress,
    inputAmount,
    publicClient
  )

  const transactionId = `0x${randomBytes(32).toString('hex')}` as `0x${string}`
  const destinationChainId = networks[DEST_CHAIN_EVM]?.chainId || 8453

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'near-intents',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: USDC_ARBITRUM, // Always USDC (output token after swap)
    receiver: signerAddress, // Same address on Base
    destinationChainId,
    minAmount: amount, // Exact USDC needed (pre-swap amount)
    hasSourceSwaps: withSwap,
    hasDestinationCall: false,
  }

  // Convert quote ID to bytes32
  // Use a hash of the deposit address as a unique identifier for the quote
  const cryptoModule = await import('crypto')
  const quoteIdBytes32 = `0x${cryptoModule
    .createHash('sha256')
    .update(quote.depositAddress)
    .digest('hex')}` as `0x${string}`

  const deadline = BigInt(Math.floor(new Date(quote.deadline).getTime() / 1000))
  const minAmountOut = BigInt(quote.minAmountOut)

  const nearDataForSigning = {
    quoteId: quoteIdBytes32,
    depositAddress: quote.depositAddress,
    deadline,
    minAmountOut,
    nonEVMReceiver: `0x${'0'.repeat(64)}` as `0x${string}`, // Empty for EVM
  }

  const evmSourceChainId = networks[SOURCE_CHAIN]?.chainId
  if (!evmSourceChainId) {
    throw new Error(`Chain ID not found for ${SOURCE_CHAIN}`)
  }
  const signature = await generateBackendSignature(
    walletAccount,
    lifiDiamondAddress,
    bridgeData,
    nearDataForSigning,
    evmSourceChainId
  )

  const nearData: NEARIntentsFacet.NEARIntentsDataStruct = {
    quoteId: quoteIdBytes32,
    depositAddress: quote.depositAddress,
    deadline,
    minAmountOut,
    nonEVMReceiver: `0x${'0'.repeat(64)}`,
    signature,
  }

  console.log('\n📋 Transaction Summary:')
  console.log('  Transaction ID:', bridgeData.transactionId)
  console.log('  Bridge:', bridgeData.bridge)
  console.log('  Source:', SOURCE_CHAIN)
  console.log('  Destination:', DEST_CHAIN_EVM)
  if (withSwap) {
    console.log('  Swap: USDT → USDC')
    console.log('  Max Input:', formatUnits(inputAmount, 6), 'USDT')
  }
  console.log('  Amount In:', formatUnits(amount, 6), 'USDC')
  console.log('  Expected Out:', quote.amountOutFormatted, 'USDC')
  console.log('  Deposit Address:', quote.depositAddress)
  console.log('  Receiver:', signerAddress)
  console.log('  Deadline:', new Date(Number(deadline) * 1000).toISOString())

  console.log('\n🚀 Executing bridge transaction...\n')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Diamond contract typing
  const txHash = await executeTransaction(
    () =>
      withSwap
        ? (
            lifiDiamondContract as any
          ).write.swapAndStartBridgeTokensViaNEARIntents([
            bridgeData,
            swapData,
            nearData,
          ])
        : (lifiDiamondContract as any).write.startBridgeTokensViaNEARIntents([
            bridgeData,
            nearData,
          ]),
    withSwap
      ? 'Swap USDT→USDC and bridge to Base via NEAR Intents'
      : 'Bridge USDC: Arbitrum → Base via NEAR Intents',
    publicClient,
    true
  )

  console.log('\n✅ Bridge transaction successful!')
  console.log('\n🔗 Transaction:')
  console.log(`   https://arbiscan.io/tx/${txHash}`)
  console.log('\n📊 Track swap status:')
  console.log(
    `   curl "https://1click.chaindefuser.com/v0/status?depositAddress=${quote.depositAddress}"`
  )
  console.log('\n🔗 Check balances:')
  console.log(`   Arbitrum: https://arbiscan.io/address/${signerAddress}`)
  console.log(`   Base: https://basescan.org/address/${signerAddress}`)
}

/// ========== CLI ENTRY POINT ========== ///

const command = defineCommand({
  meta: {
    name: 'demoNEARIntents',
    description: 'Demo script for NEARIntentsFacet - bridge USDC from Arbitrum',
  },
  args: {
    mode: {
      type: 'string',
      default: 'evm-to-solana',
      description:
        'Bridge mode: evm-to-evm (Arbitrum→Base) or evm-to-solana (Arbitrum→Solana)',
    },
    amount: {
      type: 'string',
      default: '1',
      description:
        'Amount of USDC to bridge (e.g., 1 for 1 USDC, 0.5 for 0.5 USDC)',
    },
    swap: {
      type: 'boolean',
      default: false,
      description: 'Perform a USDT → USDC swap before bridging',
    },
  },
  async run({
    args,
  }: {
    args: { mode: string; amount: string; swap: boolean }
  }) {
    console.log(`\n🎯 NEAR Intents Bridge Demo`)
    console.log(`   Source: Arbitrum (fixed)`)
    console.log(
      `   Destination: ${args.mode === 'evm-to-evm' ? 'Base' : 'Solana'}`
    )
    console.log(`   Mode: ${args.mode}`)
    if (args.swap) {
      console.log(`   Swap: USDT → USDC (enabled)\n`)
    } else {
      console.log()
    }

    try {
      switch (args.mode) {
        case 'evm-to-evm':
          await bridgeEVMtoEVM(args.amount, args.swap)
          break
        case 'evm-to-solana':
          await bridgeEVMtoSolana(args.amount, args.swap)
          break
        default:
          throw new Error(
            `Unknown mode: ${args.mode}. Use 'evm-to-evm' or 'evm-to-solana'`
          )
      }

      console.log('\n✨ Demo completed successfully!')
    } catch (error) {
      console.error('\n💥 Demo failed:', error)
      throw error
    }
  },
})

runMain(command)
