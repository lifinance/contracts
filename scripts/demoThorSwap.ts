import deployments from '../deployments/mainnet.staging.json'
import { ThorSwapFacet__factory, ILiFi, ThorSwapFacet, ERC20__factory, IThorSwap__factory } from '../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const ROUTE_TYPES: Record<string, number> = {
  CALL_BRIDGE: 0,
  BRIDGE_CALL: 1,
  CALL_BRIDGE_CALL: 2
}

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_MAINNET
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const squidFacet = ThorSwapFacet__factory.connect(LIFI_ADDRESS, provider)


  const iface = IThorSwap__factory.createInterface()


  // TODO: send from ETH to BTC

  // TODO: send USDC to BTC

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
