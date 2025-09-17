import { PublicKey } from '@solana/web3.js'
import { _100 } from '@uniswap/sdk/dist/constants'
import { config } from 'dotenv'
import { ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  RelayFacet__factory,
  ERC20__factory,
  type ILiFi,
  type RelayFacet,
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
  const relay = RelayFacet__factory.connect(LIFI_ADDRESS, provider)

  const address = await signer.getAddress()

  let tx

  // Bridge ETH

  // let params = {
  //   user: deployments.LiFiDiamond,
  //   originChainId: 42161,
  //   destinationChainId: 137,
  //   originCurrency: '0x0000000000000000000000000000000000000000',
  //   destinationCurrency: '0x0000000000000000000000000000000000000000',
  //   recipient: address,
  //   tradeType: 'EXACT_INPUT',
  //   amount: '1000000000000000',
  //   referrer: 'relay.link/swap',
  //   useExternalLiquidity: false,
  // }

  // let resp = await fetch('https://api.relay.link/quote', {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify(params),
  // })
  // let quote = await resp.json()
  // let requestId = quote.steps[0].requestId

  // let sigResp = await fetch(
  //   `https://api.relay.link/requests/${requestId}/signature/v2`,
  //   { headers: { 'Content-Type': 'application/json' } }
  // )
  // let sigData = await sigResp.json()

  // let bridgeData: ILiFi.BridgeDataStruct = {
  //   transactionId: utils.randomBytes(32),
  //   bridge: 'Relay',
  //   integrator: 'ACME Devs',
  //   referrer: '0x0000000000000000000000000000000000000000',
  //   sendingAssetId: '0x0000000000000000000000000000000000000000',
  //   receiver: address,
  //   minAmount: ethers.utils.parseEther('0.001'),
  //   destinationChainId: 137,
  //   hasSourceSwaps: false,
  //   hasDestinationCall: false,
  // }

  // let relayData: RelayFacet.RelayDataStruct = {
  //   requestId,
  //   nonEVMReceiver: ethers.constants.HashZero,
  //   receivingAssetId: ethers.constants.HashZero,
  //   signature: sigData.signature,
  // }

  // console.info('Dev Wallet Address: ', address)
  // console.info('Bridging ETH...')
  // tx = await relay
  //   .connect(signer)
  //   .startBridgeTokensViaRelay(bridgeData, relayData, {
  //     value: ethers.utils.parseEther('0.001'),
  //   })
  // await tx.wait()
  // console.info('Bridged ETH')

  // // Bridge USDC

  // params = {
  //   user: deployments.LiFiDiamond,
  //   originChainId: 42161,
  //   destinationChainId: 10,
  //   originCurrency: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  //   destinationCurrency: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  //   recipient: address,
  //   tradeType: 'EXACT_INPUT',
  //   amount: '5000000',
  //   referrer: 'relay.link/swap',
  //   useExternalLiquidity: false,
  // }

  // resp = await fetch('https://api.relay.link/quote', {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify(params),
  // })
  // quote = await resp.json()
  // requestId = quote.steps[0].requestId

  // sigResp = await fetch(
  //   `https://api.relay.link/requests/${requestId}/signature/v2`,
  //   { headers: { 'Content-Type': 'application/json' } }
  // )
  // sigData = await sigResp.json()

  const token = ERC20__factory.connect(
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    provider
  )

  // bridgeData = {
  //   transactionId: utils.randomBytes(32),
  //   bridge: 'Relay',
  //   integrator: 'ACME Devs',
  //   referrer: '0x0000000000000000000000000000000000000000',
  //   sendingAssetId: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  //   receiver: address,
  //   minAmount: '5000000',
  //   destinationChainId: 10,
  //   hasSourceSwaps: false,
  //   hasDestinationCall: false,
  // }

  // relayData = {
  //   requestId,
  //   nonEVMReceiver: ethers.constants.HashZero,
  //   receivingAssetId: ethers.utils.hexZeroPad(
  //     '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  //     32
  //   ),
  //   signature: sigData.signature,
  // }

  // console.info('Dev Wallet Address: ', address)
  // console.info('Approving USDC...')
  // tx = await token.connect(signer).approve(LIFI_ADDRESS, '5000000')
  // await tx.wait()
  // console.info('Approved USDC')
  // console.info('Bridging USDC...')
  // tx = await relay
  //   .connect(signer)
  //   .startBridgeTokensViaRelay(bridgeData, relayData)
  // await tx.wait()
  // console.info('Bridged USDC')

  // // Swap USDC and Bridge ETH

  // params = {
  //   user: deployments.LiFiDiamond,
  //   originChainId: 42161,
  //   destinationChainId: 137,
  //   originCurrency: '0x0000000000000000000000000000000000000000',
  //   destinationCurrency: '0x0000000000000000000000000000000000000000',
  //   recipient: address,
  //   tradeType: 'EXACT_INPUT',
  //   amount: '1000000000000000',
  //   referrer: 'relay.link/swap',
  //   useExternalLiquidity: false,
  // }

  // resp = await fetch('https://api.relay.link/quote', {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify(params),
  // })
  // quote = await resp.json()
  // requestId = quote.steps[0].requestId

  // sigResp = await fetch(
  //   `https://api.relay.link/requests/${requestId}/signature/v2`,
  //   { headers: { 'Content-Type': 'application/json' } }
  // )
  // sigData = await sigResp.json()
  // console.log(sigData)

  // bridgeData = {
  //   transactionId: utils.randomBytes(32),
  //   bridge: 'Relay',
  //   integrator: 'ACME Devs',
  //   referrer: '0x0000000000000000000000000000000000000000',
  //   sendingAssetId: '0x0000000000000000000000000000000000000000',
  //   receiver: address,
  //   minAmount: ethers.utils.parseEther('0.001'),
  //   destinationChainId: 137,
  //   hasSourceSwaps: true,
  //   hasDestinationCall: false,
  // }

  // const swapData = []

  // const uniswapAddress = ADDRESS_UNISWAP_ARB
  // swapData[0] = await getUniswapSwapDataERC20ToETH(
  //   uniswapAddress,
  //   42161,
  //   ADDRESS_USDC_ARB,
  //   ADDRESS_WETH_ARB,
  //   ethers.utils.parseUnits('4', 6),
  //   LIFI_ADDRESS,
  //   true
  // )

  // relayData = {
  //   requestId,
  //   nonEVMReceiver: ethers.constants.HashZero,
  //   receivingAssetId: ethers.constants.HashZero,
  //   signature: sigData.signature,
  // }

  // console.info('Dev Wallet Address: ', address)
  // console.info('Approving USDC...')
  // tx = await token.connect(signer).approve(LIFI_ADDRESS, '4000000')
  // await tx.wait()
  // console.info('Approved USDC')
  // console.info('Bridging USDC -> ETH...')
  // tx = await relay
  //   .connect(signer)
  //   .swapAndStartBridgeTokensViaRelay(bridgeData, swapData, relayData)
  // await tx.wait()
  // console.info('Bridged ETH')

  // // Bridge USDC to Solana

  // const solanaReceiver = 'EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb'
  // const solanaUSDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

  // params = {
  //   user: deployments.LiFiDiamond,
  //   originChainId: 42161,
  //   destinationChainId: 792703809,
  //   originCurrency: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  //   destinationCurrency: solanaUSDC,
  //   recipient: solanaReceiver,
  //   tradeType: 'EXACT_INPUT',
  //   amount: '5000000',
  //   referrer: 'relay.link/swap',
  //   useExternalLiquidity: false,
  // }

  // resp = await fetch('https://api.relay.link/quote', {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify(params),
  // })
  // quote = await resp.json()
  // console.log(quote)
  // requestId = quote.steps[0].requestId

  // console.log(requestId)
  // sigResp = await fetch(
  //   `https://api.relay.link/requests/${requestId}/signature/v2`,
  //   { headers: { 'Content-Type': 'application/json' } }
  // )
  // sigData = await sigResp.json()
  // console.log(sigData)

  // bridgeData = {
  //   transactionId: utils.randomBytes(32),
  //   bridge: 'Relay',
  //   integrator: 'ACME Devs',
  //   referrer: '0x0000000000000000000000000000000000000000',
  //   sendingAssetId: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  //   receiver: '0x11f111f111f111F111f111f111F111f111f111F1',
  //   minAmount: '5000000',
  //   destinationChainId: 1151111081099710,
  //   hasSourceSwaps: false,
  //   hasDestinationCall: false,
  // }

  // relayData = {
  //   requestId,
  //   nonEVMReceiver: `0x${new PublicKey(solanaReceiver)
  //     .toBuffer()
  //     .toString('hex')}`,
  //   receivingAssetId: `0x${new PublicKey(solanaUSDC)
  //     .toBuffer()
  //     .toString('hex')}`,
  //   signature: sigData.signature,
  // }

  // console.info('Dev Wallet Address: ', address)
  // console.info('Approving USDC...')
  // tx = await token.connect(signer).approve(LIFI_ADDRESS, '5000000')
  // await tx.wait()
  // console.info('Approved USDC')
  // console.info('Bridging USDC...')
  // tx = await relay
  //   .connect(signer)
  //   .startBridgeTokensViaRelay(bridgeData, relayData)
  // await tx.wait()
  // console.info('Bridged USDC')

  const suiUSDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  const suiRandomReceiver = '0x02a212de6a9dfa3a69e22387acfbafbb1a9e591bd9d636e7895dcfc8de05f331'
  
  const params = {
    user: deployments.LiFiDiamond,
    originChainId: 42161,
    destinationChainId: 103665049, // SUI
    originCurrency: ADDRESS_USDC_ARB,
    destinationCurrency: suiUSDC,
    recipient: suiRandomReceiver,
    tradeType: 'EXACT_INPUT',
    amount: '1000000',
    referrer: 'relay.link/swap',
    useExternalLiquidity: false,
  }
  console.log(params)


  const resp = await fetch('https://api.relay.link/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  const quote = await resp.json()
  console.log(quote)
  const requestId = quote.steps[0].requestId

  console.log("requestId")
  console.log("requestId")
  console.log("requestId")
  console.log("requestId")
  console.log("requestId")
  console.log(requestId)
  console.log(requestId)
  console.log(requestId)
  console.log(requestId)
  console.log(requestId)
  const sigResp = await fetch(
    `https://api.relay.link/requests/${requestId}/signature/v2`,
    { headers: { 'Content-Type': 'application/json' } }
  )
  console.log("sigResp")
  console.log(sigResp)
  const sigData = await sigResp.json()
  console.log(sigData)

  // const bridgeData = {
  //   transactionId: utils.randomBytes(32),
  //   bridge: 'Relay',
  //   integrator: 'ACME Devs',
  //   referrer: '0x0000000000000000000000000000000000000000',
  //   sendingAssetId: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  //   receiver: suiRandomReceiver,
  //   minAmount: '500000',
  //   destinationChainId: 9270000000000000, // SUI
  //   hasSourceSwaps: false,
  //   hasDestinationCall: false,
  // }

  // const relayData = {
  //   requestId,
  //   nonEVMReceiver: `0x${new PublicKey(suiRandomReceiver)
  //     .toBuffer()
  //     .toString('hex')}`,
  //   receivingAssetId: `0x${new PublicKey(suiUSDC)
  //     .toBuffer()
  //     .toString('hex')}`,
  //   signature: sigData.signature,
  // }

  // console.info('Dev Wallet Address: ', address)
  // console.info('Approving USDC...')
  // tx = await token.connect(signer).approve(LIFI_ADDRESS, '500000')
  // await tx.wait()
  // console.info('Approved USDC')
  // console.info('Bridging USDC...')
  // tx = await relay
  //   .connect(signer)
  //   .startBridgeTokensViaRelay(bridgeData, relayData)
  // await tx.wait()
  // console.info('Bridged USDC')
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
