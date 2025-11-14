#!/usr/bin/env bunx tsx

import { consola } from 'consola'
import { config } from 'dotenv'
import { BigNumber, constants, utils } from 'ethers'

import deploymentsARB from '../../deployments/arbitrum.staging.json'
import deploymentsOPT from '../../deployments/optimism.staging.json'
import {
  type ILiFi,
  type PolymerCCTPFacet,
  PolymerCCTPFacet__factory,
} from '../../typechain'

import {
  ADDRESS_DEV_WALLET_SOLANA_BYTES32,
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_OPT,
  DEV_WALLET_ADDRESS,
  ensureBalanceAndAllowanceToDiamond,
  getProvider,
  getWalletFromPrivateKeyInDotEnv,
  sendTransaction,
} from './utils/demoScriptHelpers'

config()

// ########################################## CONFIGURE SCRIPT HERE ##########################################
const BRIDGE_TO_SOLANA = false // Set BRIDGE_TO_SOLANA=true to bridge to Solana
const SEND_TX = false // Set to false to dry-run without sending transaction
const USE_FAST_MODE = false // Set to true for fast route (1000), false for standard route (2000)

// Polymer API configuration
// TODO: update to mainnet API URL once available
const POLYMER_API_URL = 'https://lifi.devnet.polymer.zone'

// Source chain: 'arbitrum' or 'optimism'
const SRC_CHAIN = 'optimism' as 'arbitrum' | 'optimism'
const DIAMOND_ADDRESS_SRC =
  SRC_CHAIN === 'arbitrum'
    ? deploymentsARB.LiFiDiamond
    : deploymentsOPT.LiFiDiamond

// Destination chain ID
const LIFI_CHAIN_ID_SOLANA = 1151111081099710
// Testnet chain IDs (for devnet API)
// TODO: update to mainnet values once supported by API
const LIFI_CHAIN_ID_ARBITRUM_SEPOLIA = 421614
const LIFI_CHAIN_ID_OPTIMISM_SEPOLIA = 11155420
const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'

// For EVM destinations, use Arbitrum if source is Optimism, and vice versa
// Using testnet chain IDs for devnet API
const DST_CHAIN_ID_EVM =
  SRC_CHAIN === 'arbitrum'
    ? LIFI_CHAIN_ID_OPTIMISM_SEPOLIA
    : LIFI_CHAIN_ID_ARBITRUM_SEPOLIA // Optimism Sepolia or Arbitrum Sepolia
const DST_CHAIN_ID = BRIDGE_TO_SOLANA ? LIFI_CHAIN_ID_SOLANA : DST_CHAIN_ID_EVM

// Token addresses
const sendingAssetId =
  SRC_CHAIN === 'arbitrum' ? ADDRESS_USDC_ARB : ADDRESS_USDC_OPT
const fromAmount = '1000000' // 1 USDC (6 decimals)

// Receiver address
const receiverAddress = BRIDGE_TO_SOLANA
  ? NON_EVM_ADDRESS // Use NON_EVM_ADDRESS for Solana
  : DEV_WALLET_ADDRESS // Use EVM address for EVM destinations

// Solana receiver (bytes32 format) - only used when BRIDGE_TO_SOLANA is true
const solanaReceiverBytes32 = ADDRESS_DEV_WALLET_SOLANA_BYTES32

// Polymer CCTP specific parameters
// polymerTokenFee will be extracted from API response
const maxCCTPFee = '0' // Max CCTP fee (0 = no limit)
const minFinalityThreshold = USE_FAST_MODE ? 1000 : 2000 // 1000 = fast path, 2000 = standard path

const EXPLORER_BASE_URL =
  SRC_CHAIN === 'arbitrum'
    ? 'https://arbiscan.io/tx/'
    : 'https://optimistic.etherscan.io/tx/'

// ############################################################################################################

// Polymer API types
interface IFeeCost {
  name: string
  description: string
  percentage?: string
  chainId?: number
  tokenAddress?: string
  token?: {
    address: string
    symbol: string
    name: string
    decimals: number
    chainId: number
    coinKey: string
    priceUSD?: string
  }
  amount: string
  amountUSD?: string
  included: boolean
}

interface IQuoteResponse {
  toAmount: string
  toAmountMin: string
  executionDuration: number
  gasEstimate: string
  feeCosts: IFeeCost[]
  parameters?: {
    polymerTokenFee?: string
    [key: string]: unknown
  }
  steps?: unknown[]
  [key: string]: unknown
}

/**
 * Get quote from Polymer API
 * Calls v1/quote/fast for fast mode or v1/quote/standard for standard mode
 * Returns the quote response and extracted polymerTokenFee
 */
async function getPolymerQuote(
  fromChainId: number,
  toChainId: number,
  fromToken: string,
  toToken: string,
  fromAmount: string,
  toAddress: string
): Promise<{ quote: IQuoteResponse; polymerTokenFee: string }> {
  const quoteType = USE_FAST_MODE ? 'fast' : 'standard'
  consola.info(`\n📡 Fetching ${quoteType} quote from Polymer API...`)

  // Build query parameters
  const queryParams = new URLSearchParams({
    fromChain: fromChainId.toString(),
    toChain: toChainId.toString(),
    fromToken,
    toToken,
    fromAmount,
    toAddress,
  })

  const fullApiUrl = `${POLYMER_API_URL}/v1/quote/${quoteType}?${queryParams.toString()}`
  consola.info(`API URL: ${fullApiUrl}`)
  consola.info(
    `Request: fromChain=${fromChainId}, toChain=${toChainId}, fromAmount=${fromAmount}`
  )

  const quoteResponse = await fetch(fullApiUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  if (!quoteResponse.ok) {
    const errorText = await quoteResponse.text()
    throw new Error(
      `Failed to get quote from Polymer API: ${quoteResponse.status} - ${errorText}`
    )
  }

  const quoteData: IQuoteResponse = await quoteResponse.json()

  if ('error' in quoteData) {
    throw new Error(`Polymer API error: ${JSON.stringify(quoteData.error)}`)
  }

  // Extract polymerTokenFee from feeCosts
  // Standard path: polymerTokenFee = 0 (no CCTP service fee)
  // Fast path: polymerTokenFee > 0 (CCTP service fee charged by Circle, included in amount)
  // The "CCTP service fee" with included: true is the fee deducted from the bridged amount
  let polymerTokenFee = '0'
  if (quoteData.feeCosts) {
    // Look for CCTP service fee (fast path) - this is the fee that's included/deducted
    const cctpServiceFee = quoteData.feeCosts.find(
      (fee) =>
        fee.name.toLowerCase().includes('cctp') &&
        fee.name.toLowerCase().includes('service') &&
        fee.included === true
    )
    if (cctpServiceFee && cctpServiceFee.amount) {
      polymerTokenFee = cctpServiceFee.amount
    }
  }

  consola.success(`✓ ${quoteType} quote received from Polymer API`)
  consola.info('\n📊 POLYMER API QUOTE RESPONSE:')
  consola.info(JSON.stringify(quoteData, null, 2))
  consola.info(`\n✅ Received ${quoteType} route`)
  consola.info(`💰 Extracted polymerTokenFee: ${polymerTokenFee}`)

  return { quote: quoteData, polymerTokenFee }
}

async function main() {
  const provider = getProvider(SRC_CHAIN)
  const wallet = getWalletFromPrivateKeyInDotEnv(provider)
  const walletAddress = await wallet.getAddress()
  consola.info('Using wallet address:', walletAddress)

  // Get diamond contract
  const polymerCCTPFacet = PolymerCCTPFacet__factory.connect(
    DIAMOND_ADDRESS_SRC,
    wallet
  )
  consola.info('Diamond/PolymerCCTPFacet connected:', polymerCCTPFacet.address)

  // Display route details
  consola.info('\n🌉 BRIDGE ROUTE DETAILS:')
  const sourceChainId =
    SRC_CHAIN === 'arbitrum'
      ? LIFI_CHAIN_ID_ARBITRUM_SEPOLIA
      : LIFI_CHAIN_ID_OPTIMISM_SEPOLIA
  const sourceChainName =
    SRC_CHAIN === 'arbitrum' ? 'Arbitrum Sepolia' : 'Optimism Sepolia'
  const destChainName = BRIDGE_TO_SOLANA
    ? 'Solana'
    : SRC_CHAIN === 'arbitrum'
    ? 'Optimism Sepolia'
    : 'Arbitrum Sepolia'
  consola.info(
    `📤 Source Chain: ${sourceChainName} (Chain ID: ${sourceChainId})`
  )
  consola.info(
    `📥 Destination Chain: ${destChainName} (Chain ID: ${DST_CHAIN_ID})`
  )
  consola.info(
    `💰 Amount: ${BigNumber.from(fromAmount).div(1e6).toString()} USDC`
  )
  consola.info(`🎯 Sending Asset: ${sendingAssetId}`)
  consola.info(
    `👤 Receiver: ${
      BRIDGE_TO_SOLANA ? 'Solana address (bytes32)' : walletAddress
    }`
  )
  consola.info(`⚡ Mode: ${USE_FAST_MODE ? 'Fast' : 'Standard'}`)
  consola.info('')

  // Get quote from Polymer API
  // Using testnet chain IDs for devnet API
  // For Solana, use LiFi chain ID directly (Polymer API may use LiFi chain IDs for non-EVM chains)
  // Note: Solana support may be limited in devnet - if you get "not supported by CCTP" error,
  // Solana might not be available in the devnet API yet
  const destinationChainIdPolymer = BRIDGE_TO_SOLANA
    ? LIFI_CHAIN_ID_SOLANA
    : DST_CHAIN_ID

  const { quote: polymerQuote, polymerTokenFee } = await getPolymerQuote(
    sourceChainId,
    destinationChainIdPolymer,
    sendingAssetId,
    sendingAssetId, // Same token (USDC) on both sides
    fromAmount,
    receiverAddress
  )

  // Log quote details
  consola.info(`📊 Quote Details:`)
  consola.info(`  To Amount: ${polymerQuote.toAmount}`)
  consola.info(`  To Amount Min: ${polymerQuote.toAmountMin}`)
  consola.info(`  Execution Duration: ${polymerQuote.executionDuration}s`)
  if (polymerQuote.feeCosts && polymerQuote.feeCosts.length > 0) {
    consola.info(`  Fee Costs:`)
    polymerQuote.feeCosts.forEach((fee) => {
      const tokenSymbol = fee.token?.symbol || fee.tokenAddress || 'N/A'
      consola.info(
        `    - ${fee.name}: ${fee.amount} ${tokenSymbol} (${
          fee.amountUSD || 'N/A'
        } USD)`
      )
    })
  }

  // Prepare bridge data
  // Note: The facet transfers minAmount from user, then deducts polymerTokenFee before bridging
  // So if minAmount = fromAmount, the bridged amount will be fromAmount - polymerTokenFee
  // User must approve minAmount (which equals fromAmount in this case)
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'polymercctp',
    integrator: 'demoScript',
    referrer: constants.AddressZero,
    sendingAssetId,
    receiver: receiverAddress,
    minAmount: fromAmount, // Total amount to transfer; bridged amount = minAmount - polymerTokenFee
    destinationChainId: DST_CHAIN_ID,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }
  consola.info('📋 bridgeData prepared')
  consola.info(
    `  minAmount: ${fromAmount} (bridged amount will be ${BigNumber.from(
      fromAmount
    )
      .sub(BigNumber.from(polymerTokenFee))
      .toString()})`
  )

  // Prepare PolymerCCTP data
  const polymerData: PolymerCCTPFacet.PolymerCCTPDataStruct = {
    polymerTokenFee,
    maxCCTPFee,
    nonEVMReceiver: BRIDGE_TO_SOLANA
      ? solanaReceiverBytes32
      : constants.HashZero,
    minFinalityThreshold,
  }
  consola.info('📋 polymerData prepared')
  consola.info(`  polymerTokenFee: ${polymerTokenFee}`)
  consola.info(
    `  minFinalityThreshold: ${minFinalityThreshold} (${
      USE_FAST_MODE ? 'fast' : 'standard'
    } path)`
  )

  // Ensure balance and allowance
  // Contract transfers minAmount, so user must approve minAmount (fromAmount)
  const totalAmountNeeded = BigNumber.from(fromAmount)
  if (SEND_TX) {
    await ensureBalanceAndAllowanceToDiamond(
      sendingAssetId,
      wallet,
      DIAMOND_ADDRESS_SRC,
      totalAmountNeeded,
      false
    )
    consola.info('✅ Balance and allowance verified')
    consola.info(
      `  Approved amount: ${totalAmountNeeded.toString()} (will bridge: ${BigNumber.from(
        fromAmount
      )
        .sub(BigNumber.from(polymerTokenFee))
        .toString()}, fee: ${polymerTokenFee})`
    )
  }

  // Execute transaction
  if (SEND_TX) {
    consola.info('🚀 Executing bridge transaction...')

    const executeTxData = await polymerCCTPFacet.populateTransaction
      .startBridgeTokensViaPolymerCCTP(bridgeData, polymerData)
      .then((tx) => tx.data)

    if (!executeTxData) {
      throw new Error('Failed to populate transaction data')
    }

    const transactionResponse = await sendTransaction(
      wallet,
      polymerCCTPFacet.address,
      executeTxData,
      BigNumber.from(0)
    )

    consola.info('\n🎉 BRIDGE TRANSACTION EXECUTED SUCCESSFULLY!')
    consola.info(`📤 Transaction Hash: ${transactionResponse.hash}`)
    consola.info(
      `🔗 Explorer Link: ${EXPLORER_BASE_URL}${transactionResponse.hash}`
    )
    consola.info(
      `💰 Amount Bridged: ${BigNumber.from(fromAmount)
        .div(1e6)
        .toString()} USDC`
    )
    consola.info(
      `📥 Destination: ${
        BRIDGE_TO_SOLANA
          ? 'Solana'
          : SRC_CHAIN === 'arbitrum'
          ? 'Optimism'
          : 'Arbitrum'
      }`
    )
    consola.info('')
  } else {
    consola.info('🔍 Dry-run mode: Transaction not sent')
    const executeTxData = await polymerCCTPFacet.populateTransaction
      .startBridgeTokensViaPolymerCCTP(bridgeData, polymerData)
      .then((tx) => tx.data)
    consola.info('Calldata:', executeTxData)
  }
}

main()
  .then(() => {
    consola.info('Script successfully completed')
    process.exit(0)
  })
  .catch((error) => {
    consola.error(error)
    consola.info('Script ended with errors :(')
    process.exit(1)
  })
