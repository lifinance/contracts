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

// IMPORTANT: For Solana destinations, ensure the receiver address has an Associated Token Account (ATA) for USDC.
// Without an ATA, the relayer will revert when trying to mint tokens on Solana, resulting in a poor state where
// funds are burned on the source chain but cannot be received on Solana.
// Polymer team offered to do this check and return an error if the address does not have an ATA attached.
// But a better UX could be that our backend will identify such cases and create an ATA for that account (if possible)

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT ---------------------------------------------------------------------------------------------------
// OPT.USDC > ARB.USDC (fast path):
//  SEND: https://optimistic.etherscan.io/tx/0xf7ebf406f50fe216552cc1bbee1aeec427a380f608d55b5ded3759f54e41d9d0
//  RECEIVE: https://arbiscan.io/tx/0x59c024637bd850daf78ced41c0d91fd20e0cc08dc21482d4a5c56900b9db575c
// OPT.USDC > ARB.USDC (standard path):
//  SEND: https://optimistic.etherscan.io/tx/0xcdb40f5a2960544cba0bca90a6405e0f945b5831af5f867bea63b1cd6fe6514b
//  RECEIVE: https://arbiscan.io/tx/0xfb6ac6f8dd9369cff32ffc2c6a166a4252f310ab1253d53fa13960dbee530824
// ---------------------------------------------------------------------------------------------------------------------------------------------------

// ########################################## CONFIGURE SCRIPT HERE ##########################################
const BRIDGE_TO_SOLANA = false
const SEND_TX = false // Set to false to dry-run without sending transaction
const USE_FAST_MODE = false // Set to true for fast route (1000), false for standard route (2000)

// Polymer API configuration
// const POLYMER_API_URL = 'https://lifi.devnet.polymer.zone' // testnet API URL
const POLYMER_API_URL = 'https://lifi.shadownet.polymer.zone' // mainnet API URL

// Source chain: 'arbitrum' or 'optimism'
const SRC_CHAIN = 'optimism' as 'arbitrum' | 'optimism'

// in order to test with our staging diamond, the polymer team needs to update their off-chain logic
// to monitor our addresses. So far we tested with their deployments.
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

const LIFI_CHAIN_ID_SOLANA = 1151111081099710
const LIFI_CHAIN_ID_ARBITRUM = 42161
const LIFI_CHAIN_ID_OPTIMISM = 10

// Polymer API chain IDs (different from LiFi chain IDs)
// Note: even though SOLANA's custom chain id in LifiData.sol is 1151111081099710,
// polymer's chain id for solana is 2, so we need to pass in 2 for the polymer endpoint
const POLYMER_CHAIN_ID_SOLANA = 2

const DST_CHAIN_ID_EVM =
  SRC_CHAIN === 'arbitrum' ? LIFI_CHAIN_ID_OPTIMISM : LIFI_CHAIN_ID_ARBITRUM
const DST_CHAIN_ID = BRIDGE_TO_SOLANA ? LIFI_CHAIN_ID_SOLANA : DST_CHAIN_ID_EVM

const sendingAssetId = getAddress(
  SRC_CHAIN === 'arbitrum' ? ADDRESS_USDC_ARB : ADDRESS_USDC_OPT
)
const fromAmount = parseUnits('1', 6) // 1 USDC (6 decimals)

const receiverAddress = getAddress(
  BRIDGE_TO_SOLANA ? NON_EVM_ADDRESS : DEV_WALLET_ADDRESS
)
const solanaReceiverBytes32 = ADDRESS_DEV_WALLET_SOLANA_BYTES32

const EXPLORER_BASE_URL =
  SRC_CHAIN === 'arbitrum'
    ? 'https://arbiscan.io/tx/'
    : 'https://optimistic.etherscan.io/tx/'

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
  callParameters?: {
    _polymerData?: {
      polymerTokenFee?: string
      maxCCTPFee?: string
      minFinalityThreshold?: string
      [key: string]: unknown
    }
    gasEstimate?: number
    [key: string]: unknown
  }
  parameters?: {
    polymerTokenFee?: string
    maxCCTPFee?: string
    [key: string]: unknown
  }
  steps?: unknown[]
  [key: string]: unknown
}

/**
 * Get quote from Polymer API
 * Calls v1/quote/fast for fast mode or v1/quote/standard for standard mode
 * Returns the quote response and extracted fees
 */
async function getPolymerQuote(
  fromChainId: number,
  toChainId: number,
  fromToken: string,
  toToken: string,
  fromAmount: bigint,
  toAddress: string
): Promise<{
  polymerQuote: IQuoteResponse
  polymerTokenFee: bigint
  maxCCTPFee: bigint
  minFinalityThreshold: number
}> {
  const quoteType = USE_FAST_MODE ? 'fast' : 'standard'
  consola.info(`\n📡 Fetching ${quoteType} quote from Polymer API...`)

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

  consola.success(`✓ ${quoteType} quote received from Polymer API`)
  consola.info('\n' + '='.repeat(80))
  consola.info('📊 POLYMER API QUOTE RESPONSE:')
  consola.info('='.repeat(80))
  consola.info(JSON.stringify(quoteData, null, 2))
  consola.info('='.repeat(80))

  // Extract fees from callParameters._polymerData (new API format)
  if (!quoteData.callParameters?._polymerData) {
    throw new Error(
      'Polymer API response missing callParameters._polymerData. API format may have changed.'
    )
  }

  const polymerData = quoteData.callParameters._polymerData

  if (polymerData.polymerTokenFee === undefined) {
    throw new Error(
      'Polymer API response missing polymerTokenFee in callParameters._polymerData'
    )
  }
  const polymerTokenFee = BigInt(polymerData.polymerTokenFee)

  if (polymerData.maxCCTPFee === undefined) {
    throw new Error(
      'Polymer API response missing maxCCTPFee in callParameters._polymerData'
    )
  }
  const maxCCTPFee = BigInt(polymerData.maxCCTPFee)

  if (polymerData.minFinalityThreshold === undefined) {
    throw new Error(
      'Polymer API response missing minFinalityThreshold in callParameters._polymerData'
    )
  }
  const minFinalityThreshold = Number(polymerData.minFinalityThreshold)

  consola.info('\n✅ Extracted parameters from callParameters._polymerData:')
  consola.info(`  polymerTokenFee: ${polymerTokenFee}`)
  consola.info(`  maxCCTPFee: ${maxCCTPFee} (0 = no limit)`)
  consola.info(
    `  minFinalityThreshold: ${minFinalityThreshold} (${
      minFinalityThreshold === 1000 ? 'fast path' : 'standard path'
    })`
  )

  consola.info('\n📋 EXTRACTED PARAMETERS SUMMARY:')
  consola.info(`  polymerTokenFee: ${polymerTokenFee.toString()}`)
  consola.info(`  maxCCTPFee: ${maxCCTPFee.toString()} (0 = no limit)`)
  consola.info(
    `  minFinalityThreshold: ${minFinalityThreshold} (${
      minFinalityThreshold === 1000 ? 'fast path' : 'standard path'
    })`
  )
  consola.info(`  Route Type: ${quoteType}`)

  return {
    polymerQuote: quoteData,
    polymerTokenFee,
    maxCCTPFee,
    minFinalityThreshold,
  }
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

  // Polymer API uses its own chain ID mapping (Solana = 2, not LiFi's 1151111081099710)
  // Polymer API uses its own chain ID mapping (Solana = 2, not LiFi's 1151111081099710)
  const destinationChainIdPolymer = BRIDGE_TO_SOLANA
    ? POLYMER_CHAIN_ID_SOLANA
    : DST_CHAIN_ID

  // Get quote from Polymer API
  // For Solana, use Polymer chain ID (2) for API call, but LiFi chain ID for bridge data
  const { polymerQuote, polymerTokenFee, maxCCTPFee, minFinalityThreshold } =
    await getPolymerQuote(
      sourceChainId,
      destinationChainIdPolymer,
      sendingAssetId,
      BRIDGE_TO_SOLANA ? ADDRESS_USDC_SOL : sendingAssetId, // Use Solana USDC (base58) for Solana destinations
      fromAmount,
      receiverAddress
    )

  consola.info('\n📊 QUOTE BREAKDOWN:')
  consola.info(`  To Amount: ${polymerQuote.toAmount}`)
  consola.info(`  To Amount Min: ${polymerQuote.toAmountMin}`)
  consola.info(`  Execution Duration: ${polymerQuote.executionDuration}s`)
  consola.info(`  Gas Estimate: ${polymerQuote.gasEstimate}`)
  if (polymerQuote.feeCosts && polymerQuote.feeCosts.length > 0) {
    consola.info(`\n  Fee Costs Breakdown:`)
    polymerQuote.feeCosts.forEach((fee) => {
      const tokenSymbol = fee.token?.symbol || fee.tokenAddress || 'N/A'
      const included = fee.included ? '(included)' : '(additional)'
      consola.info(
        `    - ${fee.name}: ${fee.amount} ${tokenSymbol} (${
          fee.amountUSD || 'N/A'
        } USD) ${included}`
      )
      if (fee.description) {
        consola.info(`      Description: ${fee.description}`)
      }
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

  // Prepare PolymerCCTP data using fees extracted from API response
  const polymerData: PolymerCCTPFacet.PolymerCCTPDataStruct = {
    polymerTokenFee: polymerTokenFee.toString(),
    maxCCTPFee: maxCCTPFee.toString(),
    nonEVMReceiver: BRIDGE_TO_SOLANA
      ? toHex(solanaReceiverBytes32)
      : toHex(0, { size: 32 }),
    minFinalityThreshold,
  }
  consola.info('\n📋 POLYMER CCTP DATA PREPARED:')
  consola.info(`  polymerTokenFee: ${polymerData.polymerTokenFee} (from API)`)
  consola.info(
    `  maxCCTPFee: ${polymerData.maxCCTPFee} (${
      maxCCTPFee === 0n ? '0 = no limit' : 'from API'
    })`
  )
  consola.info(`  nonEVMReceiver: ${polymerData.nonEVMReceiver}`)
  consola.info(
    `  minFinalityThreshold: ${polymerData.minFinalityThreshold} (from API, ${
      minFinalityThreshold === 1000 ? 'fast path' : 'standard path'
    })`
  )

  if (SEND_TX) {
    const tokenContract = createContractObject(
      sendingAssetId,
      ERC20__factory.abi,
      publicClient,
      walletClient
    )

    // Contract transfers minAmount, so user must approve minAmount (fromAmount)
    await ensureBalance(tokenContract, walletAddress, fromAmount, publicClient)
    await ensureAllowance(
      tokenContract,
      walletAddress,
      DIAMOND_ADDRESS_SRC,
      fromAmount,
      publicClient
    )
    consola.info('\n✅ Balance and allowance verified')
    const bridgeAmount = fromAmount - polymerTokenFee
    consola.info(`  Approved amount: ${fromAmount.toString()}`)
    consola.info(`  Polymer fee: ${polymerTokenFee.toString()}`)
    consola.info(`  Amount to bridge: ${bridgeAmount.toString()}`)
    consola.info(
      `  Expected receive amount: ${formatUnits(bridgeAmount, 6)} USDC`
    )
  }

  // Execute transaction
  if (SEND_TX) {
    consola.info('🚀 Executing bridge transaction...')

    const hash = await executeTransaction(
      () =>
        (
          polymerCCTPFacet.write as {
            startBridgeTokensViaPolymerCCTP: (
              args: [
                ILiFi.BridgeDataStruct,
                PolymerCCTPFacet.PolymerCCTPDataStruct
              ]
            ) => Promise<`0x${string}`>
          }
        ).startBridgeTokensViaPolymerCCTP([bridgeData, polymerData]),
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
      args: [bridgeData, polymerData] as unknown as Parameters<
        typeof polymerCCTPFacet.write.startBridgeTokensViaPolymerCCTP
      >[0],
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
