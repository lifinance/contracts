import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { PolygonBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

// Test process
// Approve USDC for LiFiDiamond for swapping
// Swap USDC -> DAI via uniswap on Mainnet
// Bridge DAI -> POS DAI via polygon native bridge

const LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0' // staging LiFiDiamond address
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F' // DAI address on mainnet
const POS_DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063' // POS DAI address on polygon
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC address on mainnet
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // Uniswap router address on mainnet
const destinationChainId = 137 // Polygon chain id

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(node_url('mainnet'))
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = PolygonBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)
  const token = ERC20__factory.connect(USDC_ADDRESS, wallet)

  const uniswap = new Contract(UNISWAP_ADDRESS, [
    'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])

  const amountIn = utils.parseUnits('5', 6)
  const amountOut = utils.parseEther('4')
  const path = [USDC_ADDRESS, DAI_ADDRESS]
  const to = LIFI_ADDRESS // should be a checksummed recipient address
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

  const swapData = await uniswap.populateTransaction.swapTokensForExactTokens(
    amountOut,
    amountIn,
    path,
    to,
    deadline
  )

  const lifiData = {
    transactionId: utils.randomBytes(32),
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: USDC_ADDRESS,
    receivingAssetId: POS_DAI_ADDRESS,
    receiver: walletAddress,
    destinationChainId: destinationChainId,
    amount: amountOut,
  }

  const bridgeData = {
    assetId: DAI_ADDRESS,
    amount: amountOut,
    receiver: walletAddress,
  }

  // Approve ERC20 for swapping -- USDC -> DAI
  const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
  if (amountIn.gt(allowance)) {
    await token.approve(lifi.address, amountIn)

    msg('Token approved for swapping')
  }

  // Call LiFi smart contract to start the bridge process -- WITH SWAP
  await lifi.swapAndStartBridgeTokensViaPolygonBridge(
    lifiData,
    [
      {
        sendingAssetId: USDC_ADDRESS,
        approveTo: <string>swapData.to,
        receivingAssetId: DAI_ADDRESS,
        fromAmount: amountIn,
        callTo: <string>swapData.to,
        callData: <string>swapData?.data,
      },
    ],
    bridgeData,
    {
      gasLimit: '500000',
    }
  )
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
