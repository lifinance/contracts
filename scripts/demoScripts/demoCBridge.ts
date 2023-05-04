import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { CBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../../utils/network'
import chalk from 'chalk'
import * as deployment from '../export/deployments-staging.json'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address
const destinationChainId = 56
const MAX_SLIPPAGE = 1000000

const POLYGON_USDT_ADDRESS = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
const POLYGON_USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const BSC_USDC_ADDRESS = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'

const UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'

async function main() {
  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  const provider1 = new providers.JsonRpcProvider(node_url('polygon'))
  const provider = new providers.FallbackProvider([provider1])
  wallet = wallet.connect(provider)

  const lifi = CBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)
  console.log('ADDRESS', lifi.address)
  const amountIn = '25000000'
  const amountOut = '20000010'

  const path = [POLYGON_USDC_ADDRESS, POLYGON_USDT_ADDRESS]
  const to = LIFI_ADDRESS // should be a checksummed recipient address
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

  const uniswap = new Contract(
    UNISWAP_ADDRESS,
    [
      'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    ],
    wallet
  )

  const token = ERC20__factory.connect(POLYGON_USDC_ADDRESS, wallet)
  await token.approve(lifi.address, amountOut)

  const lifiData = {
    transactionId: utils.randomBytes(32),
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: POLYGON_USDC_ADDRESS,
    receivingAssetId: BSC_USDC_ADDRESS,
    receiver: await wallet.getAddress(),
    destinationChainId: destinationChainId,
    amount: amountOut.toString(),
  }
  let CBridgeData = {
    receiver: await wallet.getAddress(),
    token: POLYGON_USDC_ADDRESS,
    amount: amountOut.toString(),
    dstChainId: destinationChainId,
    nonce: (await provider.getBlock(await provider.getBlockNumber())).timestamp,
    maxSlippage: MAX_SLIPPAGE,
  }

  // Test for startBridgeTokensViaCBridge

  await lifi.startBridgeTokensViaCBridge(lifiData, CBridgeData, {
    gasLimit: 500000,
  })

  // Test for swapAndStartBridgeTokensViaCBridge
  // Generate swap calldata

  const swapData = await uniswap.populateTransaction.swapTokensForExactTokens(
    amountOut,
    amountIn,
    path,
    to,
    deadline
  )

  // Approve ERC20 for swapping -- USDT
  await token.approve(lifi.address, amountOut)

  msg('Token approved for swapping')

  CBridgeData = {
    receiver: await wallet.getAddress(),
    token: POLYGON_USDT_ADDRESS,
    amount: amountOut.toString(),
    dstChainId: destinationChainId,
    nonce: (await provider.getBlock(await provider.getBlockNumber())).timestamp,
    maxSlippage: MAX_SLIPPAGE,
  }

  // Call LiFi smart contract to start the bridge process -- WITH SWAP
  await lifi.swapAndStartBridgeTokensViaCBridge(
    lifiData,
    [
      {
        sendingAssetId: POLYGON_USDC_ADDRESS,
        approveTo: <string>swapData.to,
        receivingAssetId: POLYGON_USDT_ADDRESS,
        fromAmount: amountIn,
        callTo: <string>swapData.to,
        callData: <string>swapData?.data,
      },
    ],
    CBridgeData,
    { gasLimit: 500000 }
  )
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
