import { providers, Wallet, utils, constants } from 'ethers'
import { OpBNBBridgeFacet__factory } from '../../typechain'
import chalk from 'chalk'
import dotenv from 'dotenv'

dotenv.config()

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' // LiFiDiamond address on BSC Testnet
const L2_GAS = 2000 // L2 Gas, Don't need to change it.
const destinationChainId = 5611 // Optimism Kovan chain id

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(
    process.env.ETH_NODE_URI_BSC_TESTNET
  )
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = new Wallet(<string>process.env.PRIVATE_KEY)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = OpBNBBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge Native Asset
  {
    // Bridge amount
    const amount = utils.parseEther('0.001')

    // LIFI Data
    const lifiData = {
      transactionId: utils.randomBytes(32),
      bridge: 'OpBNB',
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    // Bridge Data
    const bridgeData = {
      assetIdOnL2: constants.AddressZero,
      l2Gas: L2_GAS,
      isSynthetix: false,
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    msg('Sending TX to OpBNB...')
    const tx = await lifi.startBridgeTokensViaOpBNBBridge(
      lifiData,
      bridgeData,
      {
        gasLimit: '500000',
        value: amount,
      }
    )
    msg('TX Sent. Waiting for receipt...')
    await tx.wait()
    msg('Done!')
  }
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
