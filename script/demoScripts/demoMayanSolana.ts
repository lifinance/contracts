import deployments from '../../deployments/bsc.staging.json'
import {
  fetchQuote,
  getSwapFromEvmTxPayload,
  Quote,
} from '@mayanfinance/swap-sdk'
import { BigNumber, constants } from 'ethers'
import {
  MayanFacet__factory,
  ILiFi,
  type MayanFacet,
  ERC20__factory,
  IMayan__factory,
} from '../../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_BSC
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond
  const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const mayan = MayanFacet__factory.connect(LIFI_ADDRESS, provider)
  const deadline = Math.floor(Date.now() / 1000) + 60 * 10 // 10 minutes from the current Unix time

  const address = await signer.getAddress()

  let tx

  const quote: Quote = await fetchQuote({
    amount: 10,
    fromToken: BSC_USDT_ADDRESS,
    toToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    fromChain: 'bsc',
    toChain: 'solana',
    slippage: 3,
  })

  const payload = await getSwapFromEvmTxPayload(
    quote,
    '6AUWsSCRFSCbrHKH9s84wfzJXtD6mNzAHs11x6pGEcmJ',
    deadline,
    null,
    address,
    56,
    provider
  )

  const iface = IMayan__factory.createInterface()
  const parsed = iface.parseTransaction({ data: payload.data as string })

  const token = ERC20__factory.connect(BSC_USDT_ADDRESS, provider)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Mayan',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: BSC_USDT_ADDRESS,
    receiver: '0x11f111f111f111F111f111f111F111f111f111F1',
    minAmount: utils.parseEther('10'),
    destinationChainId: 1151111081099710,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const mayanData: MayanFacet.MayanDataStruct = {
    mayanAddr: parsed.args.recipient.mayanAddr,
    referrer: utils.hexZeroPad('0x', 32),
    tokenOutAddr: parsed.args.tokenOutAddr,
    receiver: parsed.args.recipient.destAddr,
    swapFee: parsed.args.relayerFees.swapFee,
    redeemFee: parsed.args.relayerFees.redeemFee,
    refundFee: parsed.args.relayerFees.refundFee,
    transferDeadline: parsed.args.criteria.transferDeadline,
    swapDeadline: parsed.args.criteria.swapDeadline,
    amountOutMin: parsed.args.criteria.amountOutMin,
    unwrap: parsed.args.criteria.unwrap,
    gasDrop: parsed.args.criteria.gasDrop,
  }

  console.info('Dev Wallet Address: ', address)
  console.info('Approving USDT...')
  const gasPrice = await provider.getGasPrice()
  tx = await token
    .connect(signer)
    .approve(LIFI_ADDRESS, constants.MaxUint256, { gasPrice })
  await tx.wait()
  console.info('Approved USDT')
  console.info('Bridging USDT...')
  tx = await mayan
    .connect(signer)
    .startBridgeTokensViaMayan(bridgeData, mayanData, { gasPrice })
  await tx.wait()
  console.info('Bridged USDT')
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
