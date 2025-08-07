import { BigNumber, utils } from 'ethers'

import deploymentsETH from '../../deployments/mainnet.json'
import { type AcrossFacetV4, AcrossFacetV4__factory } from '../../typechain'

import {
  ADDRESS_DEV_WALLET_SOLANA_BYTES32,
  ADDRESS_USDC_ETH,
  DEV_WALLET_ADDRESS,
  ensureBalanceAndAllowanceToDiamond,
  getProvider,
  getWalletFromPrivateKeyInDotEnv,
  leftPadAddressToBytes32,
  sendTransaction,
} from './utils/demoScriptHelpers'

// Simplified script to replicate the example transaction
// Example TX: https://etherscan.io/tx/0x2b9931f20443fef61a65af2e6e1ec90cb9b8f2f0828067e7370a114b14eb138e

// ########################################## CONFIGURE SCRIPT HERE ##########################################
const SEND_TX = true // Set to true to actually send the transaction

// Transaction parameters from the example
const toChainId = 34268394551451 // Solana
const sendingAssetId = ADDRESS_USDC_ETH // USDC on Ethereum
const fromAmount = '2000000' // 2 USDC (same as example transaction)
const SRC_CHAIN = 'mainnet'
const DIAMOND_ADDRESS_SRC = deploymentsETH.LiFiDiamond

// Use the same parameters as the example transaction but with our DEV wallet as recipient
const RECEIVER_ADDRESS_DST = DEV_WALLET_ADDRESS // Use regular address format for bridgeData.receiver
const EXPLORER_BASE_URL = 'https://etherscan.io/tx/'

// ############################################################################################################
async function main() {
  // get provider and wallet
  const provider = getProvider(SRC_CHAIN)
  const wallet = getWalletFromPrivateKeyInDotEnv(provider)
  const walletAddress = await wallet.getAddress()
  console.log('Using wallet address: ', walletAddress)

  // get our diamond contract to interact with (using AcrossFacetV4 interface)
  const acrossV4Facet = AcrossFacetV4__factory.connect(
    DIAMOND_ADDRESS_SRC,
    wallet
  )
  console.log('Diamond/AcrossFacetV4 connected: ', acrossV4Facet.address)

  // prepare bridgeData - simplified version
  const bridgeData = {
    transactionId: utils.randomBytes(32),
    bridge: 'acrossV4',
    integrator: 'demoScript',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: sendingAssetId,
    receiver: RECEIVER_ADDRESS_DST, // This expects an address format
    minAmount: fromAmount,
    destinationChainId: BigNumber.from(toChainId.toString()),
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }
  console.log('Bridge data prepared:')
  console.log(JSON.stringify(bridgeData, null, 2))
  console.log('--------------------------------')

  // Ensure balance and allowance
  await ensureBalanceAndAllowanceToDiamond(
    sendingAssetId,
    wallet,
    DIAMOND_ADDRESS_SRC,
    BigNumber.from(bridgeData.minAmount),
    false
  )

  // Hardcoded values from the example transaction - exact decoded parameters
  const acrossV4Data: AcrossFacetV4.AcrossV4DataStruct = {
    receiverAddress: ADDRESS_DEV_WALLET_SOLANA_BYTES32, // Our DEV wallet as recipient
    refundAddress: leftPadAddressToBytes32(walletAddress), // Use the fixed helper function
    sendingAssetId:
      '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC on Ethereum
    receivingAssetId:
      '0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61', // USDC on Solana
    outputAmount: '1997988', // Exact from example transaction
    outputAmountMultiplier: '1000000000000000000', // 1e18 for no adjustment
    exclusiveRelayer:
      '0x0000000000000000000000000000000000000000000000000000000000000000', // Exact from example
    quoteTimestamp: '1753368155', // Exact from example transaction
    fillDeadline: '1753380028', // Exact from example transaction
    exclusivityDeadline: '0', // Exact from example transaction
    message: '0x', // No message
  }
  console.log('Across V4 data prepared:')
  console.log(JSON.stringify(acrossV4Data, null, 2))

  // execute transaction
  if (SEND_TX) {
    console.log('Executing transaction...')

    // create calldata from facet interface
    const executeTxData = await acrossV4Facet.populateTransaction
      .startBridgeTokensViaAcrossV4(bridgeData, acrossV4Data)
      .then((tx) => tx.data || '0x')

    console.log('Calldata being sent:')
    console.log(executeTxData)
    console.log('--------------------------------')

    console.log('Executing transaction now')
    const transactionResponse = await sendTransaction(
      wallet,
      acrossV4Facet.address,
      executeTxData,
      BigNumber.from(0) // No ETH value needed for ERC20 transfer
    )

    console.log(
      'Transaction successfully executed: ',
      EXPLORER_BASE_URL + transactionResponse.hash
    )
  } else {
    console.log('SEND_TX is false - transaction not sent')
    console.log('Prepared data for demonstration:')
    console.log('Bridge Data:', JSON.stringify(bridgeData, null, 2))
    console.log('Across V4 Data:', JSON.stringify(acrossV4Data, null, 2))
  }
}

main()
  .then(() => {
    console.log('Script successfully completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    console.log('Script ended with errors :(')
    process.exit(1)
  })
