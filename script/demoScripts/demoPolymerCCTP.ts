#!/usr/bin/env bunx tsx

import { randomBytes } from 'crypto'

import { consola } from 'consola'
import { config } from 'dotenv'
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  getContract,
  parseUnits,
  toHex,
  zeroAddress,
} from 'viem'

import {
  ERC20__factory,
  PolymerCCTPFacet__factory,
  type ILiFi,
  type PolymerCCTPFacet,
} from '../../typechain'

import {
  ADDRESS_DEV_WALLET_SOLANA_BYTES32,
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_OPT,
  ADDRESS_USDC_SOL,
  DEV_WALLET_ADDRESS,
  NON_EVM_ADDRESS,
  createContractObject,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  logBridgeDataStruct,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// ########################################## CONFIGURE SCRIPT HERE ##########################################
const BRIDGE_TO_SOLANA = false // Set BRIDGE_TO_SOLANA=true to bridge to Solana
const SEND_TX = false // Set to false to dry-run without sending transaction
const USE_FAST_MODE = true // Set to true for fast route (1000), false for standard route (2000)

// Polymer API configuration
// const POLYMER_API_URL = 'https://lifi.devnet.polymer.zone' // testnet API URL
const POLYMER_API_URL = 'https://lifi.shadownet.polymer.zone' // mainnet API URL

// Source chain: 'arbitrum' or 'optimism'
const SRC_CHAIN = 'optimism' as 'arbitrum' | 'optimism'
// const DIAMOND_ADDRESS_SRC =
//   SRC_CHAIN === 'arbitrum'
//     ? deploymentsARB.LiFiDiamond
//     : deploymentsOPT.LiFiDiamond

// these are test deployments by Polymer team
const LIFI_DIAMOND_ADDRESS_ARB = '0xD99A49304227d3fE2c27A1F12Ef66A95b95837b6'
const LIFI_DIAMOND_ADDRESS_OPT = '0x36d7A6e0B2FE968a9558C5AaF5713aC2DAc0DbFc'
const DIAMOND_ADDRESS_SRC = getAddress(
  SRC_CHAIN === 'arbitrum' ? LIFI_DIAMOND_ADDRESS_ARB : LIFI_DIAMOND_ADDRESS_OPT
)

// Destination chain ID
const LIFI_CHAIN_ID_SOLANA = 1151111081099710
// Mainnet chain IDs
const LIFI_CHAIN_ID_ARBITRUM = 42161
const LIFI_CHAIN_ID_OPTIMISM = 10

// For EVM destinations, use Arbitrum if source is Optimism, and vice versa
const DST_CHAIN_ID_EVM =
  SRC_CHAIN === 'arbitrum' ? LIFI_CHAIN_ID_OPTIMISM : LIFI_CHAIN_ID_ARBITRUM // Optimism or Arbitrum
const DST_CHAIN_ID = BRIDGE_TO_SOLANA ? LIFI_CHAIN_ID_SOLANA : DST_CHAIN_ID_EVM

// Token addresses
const sendingAssetId = getAddress(
  SRC_CHAIN === 'arbitrum' ? ADDRESS_USDC_ARB : ADDRESS_USDC_OPT
)
const fromAmount = parseUnits('1', 6) // 1 USDC (6 decimals)

// Receiver address
const receiverAddress = getAddress(
  BRIDGE_TO_SOLANA
    ? NON_EVM_ADDRESS // Use NON_EVM_ADDRESS for Solana
    : DEV_WALLET_ADDRESS
) // Use EVM address for EVM destinations

// Solana receiver (bytes32 format) - only used when BRIDGE_TO_SOLANA is true
const solanaReceiverBytes32 = ADDRESS_DEV_WALLET_SOLANA_BYTES32

// Polymer CCTP specific parameters
// polymerTokenFee will be extracted from API response
const maxCCTPFee = 0n // Max CCTP fee (0 = no limit)
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
  fromAmount: bigint,
  toAddress: string
): Promise<{ quote: IQuoteResponse; polymerTokenFee: bigint }> {
  const quoteType = USE_FAST_MODE ? 'fast' : 'standard'
  consola.info(`\n📡 Fetching ${quoteType} quote from Polymer API...`)

  // Build query parameters
  const queryParams = new URLSearchParams({
    fromChain: fromChainId.toString(),
    toChain: toChainId.toString(),
    fromToken,
    toToken,
    fromAmount: fromAmount.toString(),
    toAddress,
  })

  const fullApiUrl = `${POLYMER_API_URL}/v1/quote/${quoteType}?${queryParams.toString()}`
  consola.info(`API URL: ${fullApiUrl}`)
  consola.info(
    `Request: fromChain=${fromChainId}, toChain=${toChainId}, fromAmount=${fromAmount.toString()}`
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
  let polymerTokenFee = 0n
  if (quoteData.feeCosts) {
    // Look for CCTP service fee (fast path) - this is the fee that's included/deducted
    const cctpServiceFee = quoteData.feeCosts.find(
      (fee) =>
        fee.name.toLowerCase().includes('cctp') &&
        fee.name.toLowerCase().includes('service') &&
        fee.included === true
    )
    if (cctpServiceFee && cctpServiceFee.amount) {
      polymerTokenFee = BigInt(cctpServiceFee.amount)
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
  // Setup environment using helper function
  const { client, publicClient, walletAccount, walletClient } =
    await setupEnvironment(SRC_CHAIN, null)
  const walletAddress = walletAccount.address
  consola.info('Using wallet address:', walletAddress)

  // Get diamond contract with custom address
  const polymerCCTPFacet = getContract({
    address: DIAMOND_ADDRESS_SRC,
    abi: PolymerCCTPFacet__factory.abi,
    client,
  })
  consola.info('Diamond/PolymerCCTPFacet connected:', DIAMOND_ADDRESS_SRC)

  // Display route details
  consola.info('\n🌉 BRIDGE ROUTE DETAILS:')
  const sourceChainId =
    SRC_CHAIN === 'arbitrum' ? LIFI_CHAIN_ID_ARBITRUM : LIFI_CHAIN_ID_OPTIMISM
  const sourceChainName = SRC_CHAIN === 'arbitrum' ? 'Arbitrum' : 'Optimism'
  const destChainName = BRIDGE_TO_SOLANA
    ? 'Solana'
    : SRC_CHAIN === 'arbitrum'
    ? 'Optimism'
    : 'Arbitrum'
  consola.info(
    `📤 Source Chain: ${sourceChainName} (Chain ID: ${sourceChainId})`
  )
  consola.info(
    `📥 Destination Chain: ${destChainName} (Chain ID: ${DST_CHAIN_ID})`
  )
  consola.info(`💰 Amount: ${formatUnits(fromAmount, 6)} USDC`)
  consola.info(`🎯 Sending Asset: ${sendingAssetId}`)
  consola.info(
    `👤 Receiver: ${
      BRIDGE_TO_SOLANA ? 'Solana address (bytes32)' : walletAddress
    }`
  )
  consola.info(`⚡ Mode: ${USE_FAST_MODE ? 'Fast' : 'Standard'}`)
  consola.info('')

  // Get quote from Polymer API
  // For Solana, use LiFi chain ID directly (Polymer API may use LiFi chain IDs for non-EVM chains)
  const destinationChainIdPolymer = BRIDGE_TO_SOLANA
    ? LIFI_CHAIN_ID_SOLANA
    : DST_CHAIN_ID

  const { quote: polymerQuote, polymerTokenFee } = await getPolymerQuote(
    sourceChainId,
    destinationChainIdPolymer,
    sendingAssetId,
    BRIDGE_TO_SOLANA ? ADDRESS_USDC_SOL : sendingAssetId, // Use Solana USDC (base58) for Solana destinations, otherwise same token
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
  const transactionId = toHex(new Uint8Array(randomBytes(32)))
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'polymercctp',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId,
    receiver: receiverAddress,
    minAmount: fromAmount.toString(), // Total amount to transfer; bridged amount = minAmount - polymerTokenFee
    destinationChainId: DST_CHAIN_ID,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }
  consola.info('')
  logBridgeDataStruct(bridgeData, consola.info)

  // Prepare PolymerCCTP data
  const polymerData: PolymerCCTPFacet.PolymerCCTPDataStruct = {
    polymerTokenFee: polymerTokenFee.toString(),
    maxCCTPFee: maxCCTPFee.toString(),
    nonEVMReceiver: BRIDGE_TO_SOLANA
      ? toHex(solanaReceiverBytes32)
      : toHex(0, { size: 32 }),
    minFinalityThreshold,
  }
  consola.info('📋 polymerData prepared:')
  consola.info(`  polymerTokenFee: ${polymerData.polymerTokenFee}`)
  consola.info(`  maxCCTPFee: ${polymerData.maxCCTPFee}`)
  consola.info(`  nonEVMReceiver: ${polymerData.nonEVMReceiver}`)
  consola.info(`  minFinalityThreshold: ${polymerData.minFinalityThreshold}`)

  // Ensure balance and allowance
  // Contract transfers minAmount, so user must approve minAmount (fromAmount)
  if (SEND_TX) {
    // Create ERC20 contract for balance/allowance checks
    const tokenContract = createContractObject(
      sendingAssetId,
      ERC20__factory.abi,
      publicClient,
      walletClient
    )

    await ensureBalance(tokenContract, walletAddress, fromAmount, publicClient)
    await ensureAllowance(
      tokenContract,
      walletAddress,
      DIAMOND_ADDRESS_SRC,
      fromAmount,
      publicClient
    )
    consola.info('✅ Balance and allowance verified')
    consola.info(
      `  Approved amount: ${fromAmount.toString()} (will bridge: ${(
        fromAmount - polymerTokenFee
      ).toString()}, fee: ${polymerTokenFee.toString()})`
    )
  }

  // Execute transaction
  if (SEND_TX) {
    consola.info('🚀 Executing bridge transaction...')

    const hash = await executeTransaction(
      () =>
        (polymerCCTPFacet.write as any).startBridgeTokensViaPolymerCCTP([
          bridgeData,
          polymerData,
        ]),
      'Starting bridge via PolymerCCTP',
      publicClient,
      true
    )

    if (!hash) {
      throw new Error('Failed to execute transaction')
    }

    consola.info('\n🎉 BRIDGE TRANSACTION EXECUTED SUCCESSFULLY!')
    consola.info(`📤 Transaction Hash: ${hash}`)
    consola.info(`🔗 Explorer Link: ${EXPLORER_BASE_URL}${hash}`)
    consola.info(`💰 Amount Bridged: ${formatUnits(fromAmount, 6)} USDC`)
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
    const executeTxData = encodeFunctionData({
      abi: PolymerCCTPFacet__factory.abi,
      functionName: 'startBridgeTokensViaPolymerCCTP',
      args: [bridgeData, polymerData] as any,
    })
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
