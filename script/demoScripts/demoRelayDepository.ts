import { config } from 'dotenv'
import { ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  ERC20__factory,
  RelayDepositoryFacet__factory,
  type ILiFi,
  type RelayDepositoryFacet,
} from '../../typechain'

import {
  ADDRESS_UNISWAP_ARB,
  ADDRESS_USDC_ARB,
  ADDRESS_WETH_ARB,
  getUniswapSwapDataERC20ToETH,
} from './utils/demoScriptHelpers'

config()

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

  // Example depository addresses - these would come from Relay API in production
  const MOCK_DEPOSITORY_ETH = '0x4cd00e387622c35bddb9b4c962c136462338bc31' // Example Base depository
  const MOCK_DEPOSITORY_USDC = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' // Example Arbitrum depository

  console.info('=== RelayDepositoryFacet Demo ===')
  console.info('Dev Wallet Address: ', address)

  // Demo 1: Deposit Native ETH to Relay Depository
  console.info('\n--- Demo 1: Deposit Native ETH ---')

  let bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'RelayDepository',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0x0000000000000000000000000000000000000000', // Native ETH
    receiver: address,
    minAmount: ethers.utils.parseEther('0.01'),
    destinationChainId: 8453, // Base
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  let relayDepositoryData: RelayDepositoryFacet.RelayDepositoryDataStruct = {
    orderId: utils.keccak256(utils.toUtf8Bytes('demo-order-eth-' + Date.now())),
    depository: MOCK_DEPOSITORY_ETH,
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
  const usdcAmount = '10000000' // 10 USDC

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
    depository: MOCK_DEPOSITORY_USDC,
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

  // Demo 3: Swap USDC to ETH and Deposit ETH
  console.info('\n--- Demo 3: Swap USDC to ETH and Deposit ---')

  const swapAmount = '5000000' // 5 USDC to swap

  bridgeData = {
    transactionId: utils.randomBytes(32),
    bridge: 'RelayDepository',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0x0000000000000000000000000000000000000000', // Native ETH after swap
    receiver: address,
    minAmount: ethers.utils.parseEther('0.001'), // Minimum ETH expected from swap
    destinationChainId: 137, // Polygon
    hasSourceSwaps: true,
    hasDestinationCall: false,
  }

  const swapData = []
  swapData[0] = await getUniswapSwapDataERC20ToETH(
    ADDRESS_UNISWAP_ARB,
    42161,
    ADDRESS_USDC_ARB,
    ADDRESS_WETH_ARB,
    ethers.utils.parseUnits('5', 6),
    LIFI_ADDRESS,
    true
  )

  relayDepositoryData = {
    orderId: utils.keccak256(
      utils.toUtf8Bytes('demo-order-swap-eth-' + Date.now())
    ),
    depository: MOCK_DEPOSITORY_ETH,
  }

  console.info('Order ID:', relayDepositoryData.orderId)
  console.info('Depository:', relayDepositoryData.depository)
  console.info('Swap Amount:', ethers.utils.formatUnits(swapAmount, 6), 'USDC')
  console.info(
    'Min ETH Expected:',
    ethers.utils.formatEther(bridgeData.minAmount.toString())
  )

  try {
    console.info('Approving USDC for swap...')
    tx = await token.connect(signer).approve(LIFI_ADDRESS, swapAmount)
    await tx.wait()
    console.info('✅ USDC approved for swap')

    console.info('Swapping USDC to ETH and depositing to Relay Depository...')
    tx = await relayDepository
      .connect(signer)
      .swapAndStartBridgeTokensViaRelayDepository(
        bridgeData,
        swapData,
        relayDepositoryData
      )
    await tx.wait()
    console.info('✅ Swap and deposit completed successfully!')
    console.info('Transaction hash:', tx.hash)
  } catch (error) {
    console.error(
      '❌ Swap and deposit failed:',
      error instanceof Error ? error.message : String(error)
    )
  }

  console.info('\n=== Demo Completed ===')
  console.info('Note: In production, depository addresses and order IDs')
  console.info(
    'would be obtained from the Relay API with protocolVersion: "v2"'
  )
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
