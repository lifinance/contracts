import { providers, Wallet, utils, constants } from 'ethers'
import chalk from 'chalk'
import { GnosisBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import config from '../config/gnosisBridge'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0'
const DAI_ADDRESS = config.mainnet.token
const amountToSwap = '1'
const destinationChainId = 100 // Gnosis

async function main() {
  msg(`Transfer ${amountToSwap} DAI on Ethereum to xDAI on Gnosis`)

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  const provider1 = new providers.JsonRpcProvider(node_url('mainnet'))
  const provider = new providers.FallbackProvider([provider1])
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = GnosisBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  const token = ERC20__factory.connect(DAI_ADDRESS, wallet)
  const amount = utils.parseEther(amountToSwap)

  const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
  if (amount.gt(allowance)) {
    await token.approve(lifi.address, amount)

    msg('Token approved for swapping')
  }

  const lifiData = {
    transactionId: utils.randomBytes(32),
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: DAI_ADDRESS,
    receivingAssetId: constants.AddressZero,
    receiver: walletAddress,
    destinationChainId: destinationChainId,
    amount: amount,
  }

  const gnosisBridgeData = {
    receiver: walletAddress,
    amount: amount,
  }

  const trx = await lifi.startBridgeTokensViaXDaiBridge(
    lifiData,
    gnosisBridgeData,
    {
      gasLimit: 500000,
    }
  )

  msg('Bridge process started on sending chain')

  await trx.wait()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
