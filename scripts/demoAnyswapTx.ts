import { providers, Wallet, utils, constants } from 'ethers'
import { AnyswapFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import * as deployment from '../export/deployments-staging.json'

const LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address
const anyTokenAddress = '0xd69b31c3225728cc57ddaf9be532a4ee1620be51'
const anyswapRouter = '0x4f3Aff3A747fCADe12598081e80c6605A8be192F'
const tokenAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const amountToSwap = '1'
const destinationChainId = 100

async function main() {
  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  const provider1 = new providers.JsonRpcProvider(node_url('polygon'))
  const provider = new providers.FallbackProvider([provider1])
  wallet = wallet.connect(provider)

  const lifi = AnyswapFacet__factory.connect(LIFI_ADDRESS, wallet)

  const token = ERC20__factory.connect(tokenAddress, wallet)
  const amount = utils.parseUnits(amountToSwap, 6)
  await token.approve(lifi.address, amount)

  const lifiData = {
    transactionId: utils.randomBytes(32),
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: anyTokenAddress,
    receivingAssetId: anyTokenAddress,
    receiver: await wallet.getAddress(),
    destinationChainId: destinationChainId,
    amount: amount.toString(),
  }

  const AnyswapData = {
    token: anyTokenAddress,
    router: anyswapRouter,
    amount: amount,
    recipient: await wallet.getAddress(),
    toChainId: destinationChainId,
  }

  await lifi.startBridgeTokensViaAnyswap(lifiData, AnyswapData, {
    gasLimit: 500000,
  })
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
