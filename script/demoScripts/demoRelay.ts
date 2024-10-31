import deployments from '../../deployments/arbitrum.staging.json'
import {
  RelayFacet__factory,
  ILiFi,
  type RelayFacet,
  ERC20__factory,
} from '../../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
import {
  ADDRESS_UNISWAP_ARB,
  ADDRESS_USDC_ARB,
  ADDRESS_WETH_ARB,
  getUniswapSwapDataERC20ToERC20,
  getUniswapSwapDataERC20ToETH,
} from './utils/demoScriptHelpers'
import { _100 } from '@uniswap/sdk/dist/constants'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const relay = RelayFacet__factory.connect(LIFI_ADDRESS, provider)

  const address = await signer.getAddress()

  let tx

  // Bridge ETH

  let params = {
    user: deployments.LiFiDiamond,
    originChainId: 42161,
    destinationChainId: 137,
    originCurrency: '0x0000000000000000000000000000000000000000',
    destinationCurrency: '0x0000000000000000000000000000000000000000',
    recipient: address,
    tradeType: 'EXACT_INPUT',
    amount: '1000000000000000',
    referrer: 'relay.link/swap',
    useExternalLiquidity: false,
  }

  // Bridge 0.001 ETH from ARB on POL
  let resp = await fetch('https://api.relay.link/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  let quote = await resp.json()
  let requestId = quote.steps[0].requestId
  console.log(quote)

  console.log(requestId)
  let sigResp = await fetch(
    `https://api.relay.link/requests/${requestId}/signature/v2`,
    { headers: { 'Content-Type': 'application/json' } }
  )
  let sigData = await sigResp.json()
  console.log(sigData)

  let bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Relay',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0x0000000000000000000000000000000000000000',
    receiver: address,
    minAmount: ethers.utils.parseEther('0.001'),
    destinationChainId: 137,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  let relayData: RelayFacet.RelayDataStruct = {
    requestId,
    receivingAssetId: '0x0000000000000000000000000000000000000000',
    callData: '0x',
    signature: sigData.signature,
  }

  console.info('Dev Wallet Address: ', address)
  console.info('Bridging ETH...')
  tx = await relay
    .connect(signer)
    .startBridgeTokensViaRelay(bridgeData, relayData, {
      value: ethers.utils.parseEther('0.001'),
    })
  await tx.wait()
  console.info('Bridged ETH')

  // Bridge USDC

  params = {
    user: deployments.LiFiDiamond,
    originChainId: 42161,
    destinationChainId: 10,
    originCurrency: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    destinationCurrency: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    recipient: address,
    tradeType: 'EXACT_INPUT',
    amount: '5000000',
    referrer: 'relay.link/swap',
    useExternalLiquidity: false,
  }

  // Bridge 0.001 ETH from ARB on POL

  resp = await fetch('https://api.relay.link/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  quote = await resp.json()
  requestId = quote.steps[0].requestId
  console.log(quote)

  console.log(requestId)
  sigResp = await fetch(
    `https://api.relay.link/requests/${requestId}/signature/v2`,
    { headers: { 'Content-Type': 'application/json' } }
  )
  sigData = await sigResp.json()
  console.log(sigData)

  const token = ERC20__factory.connect(
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    provider
  )

  bridgeData = {
    transactionId: utils.randomBytes(32),
    bridge: 'Relay',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    receiver: address,
    minAmount: '5000000',
    destinationChainId: 10,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  relayData = {
    requestId,
    receivingAssetId: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    callData: quote.steps[0].items[0].data.data,
    signature: sigData.signature,
  }

  console.info('Dev Wallet Address: ', address)
  console.info('Approving USDC...')
  tx = await token.connect(signer).approve(LIFI_ADDRESS, '5000000')
  await tx.wait()
  console.info('Approved USDC')
  console.info('Bridging USDC...')
  tx = await relay
    .connect(signer)
    .startBridgeTokensViaRelay(bridgeData, relayData)
  await tx.wait()
  console.info('Bridged USDC')

  // Swap USDC and Bridge ETH

  params = {
    user: deployments.LiFiDiamond,
    originChainId: 42161,
    destinationChainId: 137,
    originCurrency: '0x0000000000000000000000000000000000000000',
    destinationCurrency: '0x0000000000000000000000000000000000000000',
    recipient: address,
    tradeType: 'EXACT_INPUT',
    amount: '1000000000000000',
    referrer: 'relay.link/swap',
    useExternalLiquidity: false,
  }

  // Bridge 0.001 ETH from ARB on POL
  resp = await fetch('https://api.relay.link/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  quote = await resp.json()
  requestId = quote.steps[0].requestId
  console.log(quote)

  console.log(requestId)
  sigResp = await fetch(
    `https://api.relay.link/requests/${requestId}/signature/v2`,
    { headers: { 'Content-Type': 'application/json' } }
  )
  sigData = await sigResp.json()
  console.log(sigData)

  bridgeData = {
    transactionId: utils.randomBytes(32),
    bridge: 'Relay',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0x0000000000000000000000000000000000000000',
    receiver: address,
    minAmount: ethers.utils.parseEther('0.001'),
    destinationChainId: 137,
    hasSourceSwaps: true,
    hasDestinationCall: false,
  }

  const swapData = []

  const uniswapAddress = ADDRESS_UNISWAP_ARB
  swapData[0] = await getUniswapSwapDataERC20ToETH(
    uniswapAddress,
    42161,
    ADDRESS_USDC_ARB,
    ADDRESS_WETH_ARB,
    ethers.utils.parseUnits('4', 6),
    LIFI_ADDRESS,
    true
  )

  relayData = {
    requestId,
    receivingAssetId: '0x0000000000000000000000000000000000000000',
    callData: '0x',
    signature: sigData.signature,
  }

  console.info('Dev Wallet Address: ', address)
  console.info('Approving USDC...')
  tx = await token.connect(signer).approve(LIFI_ADDRESS, '4000000')
  await tx.wait()
  console.info('Approved USDC')
  console.info('Bridging USDC -> ETH...')
  tx = await relay
    .connect(signer)
    .swapAndStartBridgeTokensViaRelay(bridgeData, swapData, relayData)
  await tx.wait()
  console.info('Bridged ETH')
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
