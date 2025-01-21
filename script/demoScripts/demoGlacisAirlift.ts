import { providers, Wallet, utils, constants, Contract } from 'ethers'
import chalk from 'chalk'
import { GlacisFacet__factory, ERC20__factory } from '../../typechain'
import { node_url } from '../utils/network'
import config from '../../config/glacis.json'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' // LIFI Diamond on Arbitrum
const WORMHOLE_ADDRESS = '0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91' // Wormhole token on Arbitrum
const amountToBridge = '1'
const destinationChainId = 10 // Optimism

async function main() {
  msg(`Transfer ${amountToBridge} Wormhole on Arbitrum to Wormhole on Optimism`)
  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  const provider1 = new providers.JsonRpcProvider(node_url('arbitrum'))
  const provider = new providers.FallbackProvider([provider1])
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = GlacisFacet__factory.connect(LIFI_ADDRESS, wallet) as any

  const token = ERC20__factory.connect(WORMHOLE_ADDRESS, wallet)
  const amount = utils.parseEther(amountToBridge)

  const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
  if (amount.gt(allowance)) {
    await token.approve(lifi.address, amount)

    msg('Token approved for swapping')
  }

  const lifiData = {
    transactionId: utils.randomBytes(32),
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: WORMHOLE_ADDRESS,
    receivingAssetId: constants.AddressZero,
    receiver: walletAddress,
    destinationChainId: destinationChainId,
    amount: amount,
  }

  const airlift = new Contract(config.arbitrum.airlift, [
    'function send(address token, uint256 amount, bytes32 receiver, uint256 destinationChainId, address refundAddress) external payable',
  ])
  // calculate native fee
  const estimatedFees = await airlift.quoteSend.staticCall(
    WORMHOLE_ADDRESS,
    amount,
    walletAddress,
    destinationChainId,
    walletAddress, //refund
    utils.parseEther('1')
  )
  const structuredFees = {
    gmpFee: {
      nativeFee: estimatedFees[0][0],
      tokenFee: estimatedFees[0][1],
    },
    airliftFee: {
      nativeFee: estimatedFees[3][0][0],
      tokenFee: estimatedFees[3][0][1],
    },
  }
  console.log(structuredFees)
  const estimatedValue =
    structuredFees.gmpFee.nativeFee + structuredFees.airliftFee.nativeFee

  const glacisBridgeData = {
    receiver: walletAddress,
    amount: amount,
  }

  const trx = await lifi.startBridgeTokensViaGlacis(
    lifiData,
    glacisBridgeData,
    {
      value: estimatedValue,
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
