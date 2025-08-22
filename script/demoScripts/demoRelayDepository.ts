import { config } from 'dotenv'
import { ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  ERC20__factory,
  RelayDepositoryFacet__factory,
  type ILiFi,
  type RelayDepositoryFacet,
} from '../../typechain'

import { ADDRESS_USDC_ARB } from './utils/demoScriptHelpers'

config()

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT ---------------------------------------------------------------------------------------------------
// Deposit native on ARB: http://arbiscan.io/tx/0x326fd0b008578febee831c5e0508b13b6083e034e215389bb4885aff84fac0c2
// Deposit USDC on ARB: https://arbiscan.io/tx/0x3abee45452f7df76f571101b9bf21a875f03e5c6d43ab36d8de6898bdd00de43
// Swap USDC to native and deposit on ARB:
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const relayDepository = RelayDepositoryFacet__factory.connect(
    LIFI_ADDRESS,
    provider
  )

  const address = await signer.getAddress()

  let tx

  // Relay depository address for Arbitrum (from config/relay.json)
  const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'

  console.info('=== RelayDepositoryFacet Demo ===')
  console.info('Sending from this wallet: ', address)

  // Demo 1: Deposit Native ETH to Relay Depository
  console.info('\n--- Demo 1: Deposit Native ETH ---')

  let bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'RelayDepository',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0x0000000000000000000000000000000000000000', // Native ETH
    receiver: address,
    minAmount: ethers.utils.parseEther('0.0001'),
    destinationChainId: 42161, // We are just depositing, hence no destination chain id (using the same chain id as the source chain)
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  let relayDepositoryData: RelayDepositoryFacet.RelayDepositoryDataStruct = {
    orderId: utils.keccak256(utils.toUtf8Bytes('demo-order-eth-' + Date.now())),
    depository: RELAY_DEPOSITORY,
  }

  console.info('Order ID:', relayDepositoryData.orderId)
  console.info('Depository:', relayDepositoryData.depository)
  console.info(
    'Amount:',
    ethers.utils.formatEther(bridgeData.minAmount.toString()),
    'ETH'
  )

  try {
    console.info('Depositing ETH to Relay Depository...')
    tx = await relayDepository
      .connect(signer)
      .startBridgeTokensViaRelayDepository(bridgeData, relayDepositoryData, {
        value: bridgeData.minAmount,
      })
    await tx.wait()
    console.info('✅ ETH deposited successfully!')
    console.info('Transaction hash:', tx.hash)
  } catch (error) {
    console.error(
      '❌ ETH deposit failed:',
      error instanceof Error ? error.message : String(error)
    )
  }

  // Demo 2: Deposit USDC to Relay Depository
  console.info('\n--- Demo 2: Deposit USDC ---')

  const token = ERC20__factory.connect(ADDRESS_USDC_ARB, provider)
  const usdcAmount = '1000000' // 1 USDC

  bridgeData = {
    transactionId: utils.randomBytes(32),
    bridge: 'RelayDepository',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: ADDRESS_USDC_ARB,
    receiver: address,
    minAmount: usdcAmount,
    destinationChainId: 10, // Optimism
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  relayDepositoryData = {
    orderId: utils.keccak256(
      utils.toUtf8Bytes('demo-order-usdc-' + Date.now())
    ),
    depository: RELAY_DEPOSITORY,
  }

  console.info('Order ID:', relayDepositoryData.orderId)
  console.info('Depository:', relayDepositoryData.depository)
  console.info(
    'Amount:',
    ethers.utils.formatUnits(bridgeData.minAmount.toString(), 6),
    'USDC'
  )

  try {
    console.info('Approving USDC...')
    tx = await token.connect(signer).approve(LIFI_ADDRESS, usdcAmount)
    await tx.wait()
    console.info('✅ USDC approved')

    console.info('Depositing USDC to Relay Depository...')
    tx = await relayDepository
      .connect(signer)
      .startBridgeTokensViaRelayDepository(bridgeData, relayDepositoryData)
    await tx.wait()
    console.info('✅ USDC deposited successfully!')
    console.info('Transaction hash:', tx.hash)
  } catch (error) {
    console.error(
      '❌ USDC deposit failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

main()
  .then(() => {
    console.log('\n✅ Success - All demos completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n❌ Error occurred during demo')
    console.error(error)
    process.exit(1)
  })
