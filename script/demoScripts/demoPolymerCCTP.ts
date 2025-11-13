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
const USE_FAST_MODE = true // Set to true for fast route (1000), false for standard route (2000)

// Polymer API configuration
const POLYMER_API_URL = 'https://api.polymer.zone'

// Source chain: 'arbitrum' or 'optimism'
const SRC_CHAIN = 'optimism' as 'arbitrum' | 'optimism'
const DIAMOND_ADDRESS_SRC =
  SRC_CHAIN === 'arbitrum'
    ? deploymentsARB.LiFiDiamond
    : deploymentsOPT.LiFiDiamond

// Destination chain ID
const LIFI_CHAIN_ID_SOLANA = 1151111081099710
const LIFI_CHAIN_ID_ARBITRUM = 42161
const LIFI_CHAIN_ID_OPTIMISM = 10
const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'

// For EVM destinations, use Arbitrum if source is Optimism, and vice versa
const DST_CHAIN_ID_EVM =
  SRC_CHAIN === 'arbitrum' ? LIFI_CHAIN_ID_OPTIMISM : LIFI_CHAIN_ID_ARBITRUM // Optimism or Arbitrum
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
const polymerTokenFee = '0' // Fee taken by Polymer (can be 0)
const maxCCTPFee = '0' // Max CCTP fee (0 = no limit)
const minFinalityThreshold = USE_FAST_MODE ? 1000 : 2000 // 1000 = fast path, 2000 = standard path

const EXPLORER_BASE_URL =
  SRC_CHAIN === 'arbitrum'
    ? 'https://arbiscan.io/tx/'
    : 'https://optimistic.etherscan.io/tx/'

// ############################################################################################################

// Polymer API types
interface IRouteStep {
  action: unknown
  estimate: unknown
  tool: string
  toolDetails: unknown
}

interface IRoute {
  steps: IRouteStep[]
}

interface IRoutesResponse {
  routes: IRoute[]
}

/**
 * Get quote from Polymer API
 * Routes[0] contains the slow route (standard), Routes[1] contains the fast route
 */
async function getPolymerQuote(
  fromChainId: number,
  toChainId: number,
  fromToken: string,
  toToken: string,
  fromAmount: string,
  fromAddress: string,
  toAddress: string
): Promise<{ route: IRoute; routeIndex: number }> {
  consola.info('\n📡 Fetching quote from Polymer API...')
  const fullApiUrl = `${POLYMER_API_URL}/v1/routes`
  consola.info(`API URL: ${fullApiUrl}`)
  consola.info(
    `Request: fromChainId=${fromChainId}, toChainId=${toChainId}, fromAmount=${fromAmount}`
  )

  const requestBody = {
    fromChainId,
    toChainId,
    fromTokenAddress: fromToken,
    toTokenAddress: toToken,
    fromAmount,
    fromAddress,
    toAddress,
  }

  consola.debug('Request body:', JSON.stringify(requestBody, null, 2))

  const routesResponse = await fetch(fullApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  if (!routesResponse.ok) {
    const errorText = await routesResponse.text()
    throw new Error(
      `Failed to get quote from Polymer API: ${routesResponse.status} - ${errorText}`
    )
  }

  const routesData: IRoutesResponse = await routesResponse.json()

  if ('error' in routesData) {
    throw new Error(`Polymer API error: ${JSON.stringify(routesData.error)}`)
  }

  if (!routesData.routes || routesData.routes.length === 0) {
    throw new Error('No routes found in Polymer API response')
  }

  // Routes[0] = slow route (standard), Routes[1] = fast route
  const routeIndex = USE_FAST_MODE ? 1 : 0
  const selectedRoute = routesData.routes[routeIndex]

  if (
    !selectedRoute ||
    !selectedRoute.steps ||
    selectedRoute.steps.length === 0
  ) {
    throw new Error(
      `No ${
        USE_FAST_MODE ? 'fast' : 'standard'
      } route found in Polymer API response`
    )
  }

  consola.success('✓ Quote received from Polymer API')
  consola.info('\n📊 POLYMER API QUOTE RESPONSE:')
  consola.info(JSON.stringify(routesData, null, 2))
  consola.info(
    `\n✅ Selected ${
      USE_FAST_MODE ? 'fast' : 'standard'
    } route (index ${routeIndex})`
  )

  return { route: selectedRoute, routeIndex }
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
  consola.info(
    `📤 Source Chain: ${SRC_CHAIN} (Chain ID: ${
      SRC_CHAIN === 'arbitrum' ? 42161 : 10
    })`
  )
  consola.info(
    `📥 Destination Chain: ${
      BRIDGE_TO_SOLANA
        ? 'Solana'
        : SRC_CHAIN === 'arbitrum'
        ? 'Optimism'
        : 'Arbitrum'
    } (Chain ID: ${DST_CHAIN_ID})`
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
  const sourceChainId = SRC_CHAIN === 'arbitrum' ? 42161 : 10
  // Convert LiFi chain ID to Polymer chain ID (Solana uses 2 in Polymer API)
  const destinationChainIdPolymer = BRIDGE_TO_SOLANA ? 2 : DST_CHAIN_ID

  const { route: polymerRoute } = await getPolymerQuote(
    sourceChainId,
    destinationChainIdPolymer,
    sendingAssetId,
    sendingAssetId, // Same token (USDC) on both sides
    fromAmount,
    walletAddress,
    receiverAddress
  )

  // Extract minFinalityThreshold from route if available, otherwise use configured value
  // The route estimate might contain finality information
  if (polymerRoute.steps[0]?.estimate) {
    consola.info(
      `📋 Route estimate: ${JSON.stringify(
        polymerRoute.steps[0].estimate,
        null,
        2
      )}`
    )
  }

  // Prepare bridge data
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'polymercctp',
    integrator: 'demoScript',
    referrer: constants.AddressZero,
    sendingAssetId,
    receiver: receiverAddress,
    minAmount: fromAmount,
    destinationChainId: DST_CHAIN_ID,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }
  consola.info('📋 bridgeData prepared')

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

  // Ensure balance and allowance
  if (SEND_TX) {
    await ensureBalanceAndAllowanceToDiamond(
      sendingAssetId,
      wallet,
      DIAMOND_ADDRESS_SRC,
      BigNumber.from(fromAmount),
      false
    )
    consola.info('✅ Balance and allowance verified')
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
