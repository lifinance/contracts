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
const BRIDGE_TO_SOLANA = process.env.BRIDGE_TO_SOLANA === 'true' // Set BRIDGE_TO_SOLANA=true to bridge to Solana
const SEND_TX = true // Set to false to dry-run without sending transaction

// Source chain: 'arbitrum' or 'optimism'
const SRC_CHAIN = 'optimism' as 'arbitrum' | 'optimism'
const DIAMOND_ADDRESS_SRC =
  SRC_CHAIN === 'arbitrum'
    ? deploymentsARB.LiFiDiamond
    : deploymentsOPT.LiFiDiamond

// Destination chain ID
const LIFI_CHAIN_ID_SOLANA = 1151111081099710
const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'

// For EVM destinations, use Arbitrum if source is Optimism, and vice versa
const DST_CHAIN_ID_EVM = SRC_CHAIN === 'arbitrum' ? 10 : 42161 // Optimism or Arbitrum
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
const minFinalityThreshold = 0 // 0 = use default, < 1000 = fast path

const EXPLORER_BASE_URL =
  SRC_CHAIN === 'arbitrum'
    ? 'https://arbiscan.io/tx/'
    : 'https://optimistic.etherscan.io/tx/'

// ############################################################################################################

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
  consola.info('')

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
      .then((tx: any) => tx.data)

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
