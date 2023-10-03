import { providers, Wallet, utils, constants } from 'ethers'
import { CCIPFacet__factory, ERC20__factory } from '../../typechain'
import chalk from 'chalk'
import dotenv from 'dotenv'

dotenv.config()

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0xbEbCDb5093B47Cd7add8211E4c77B6826aF7bc5F' // LiFiDiamond address on AVAX stating
const BETS_TOKEN_ADDRESS = '0x94025780a1aB58868D9B2dBBB775f44b32e8E6e5'
const L2_GAS = 20000 // L2 Gas, Don't need to change it.
const destinationChainId = 1 // Mainnet

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(
    process.env.ETH_NODE_URI_AVALANCHE
  )
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = new Wallet(<string>process.env.PRIVATE_KEY)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = CCIPFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge amount
  const amount = utils.parseEther('10')

  // LIFI Data
  const lifiData = {
    transactionId: utils.randomBytes(32),
    bridge: 'CCIP',
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: constants.AddressZero,
    receiver: walletAddress,
    minAmount: amount,
    destinationChainId: destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // Bridge ERC20
  lifiData.sendingAssetId = BETS_TOKEN_ADDRESS

  const extraArgs = await lifi.encodeDestinationArgs(L2_GAS, false)

  const bridgeData = {
    callData: '0x',
    extraArgs,
  }

  const fee = await lifi.quoteCCIPFee(lifiData, bridgeData)

  msg('Approving BETS...')
  const BETS = ERC20__factory.connect(BETS_TOKEN_ADDRESS, wallet)
  let tx = await BETS.approve(LIFI_ADDRESS, amount)
  await tx.wait()

  msg('Sending BETS to Mainnet via CCIP...')
  tx = await lifi.startBridgeTokensViaCCIP(lifiData, bridgeData, {
    gasLimit: '500000',
    value: fee,
  })
  msg('TX Sent. Waiting for receipt...')
  await tx.wait()
  msg('Done!')
}

main()
  .then(() => {
    console.error('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
