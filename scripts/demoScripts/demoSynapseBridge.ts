import {
  providers,
  Wallet,
  utils,
  constants,
  Contract,
  BigNumberish,
} from 'ethers'
import {
  ISynapseRouter__factory,
  SynapseBridgeFacet__factory,
  ERC20__factory,
} from '../typechain'
import { node_url } from '../../utils/network'
import config from '../../config/synapse.json'
import deployments from '../../deployments/polygon.staging.json'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = deployments.LiFiDiamond
const POLYGON_DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'
const POLYGON_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const BSC_BUSD_ADDRESS = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'
const UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
const ZERO_ADDRESS = constants.AddressZero
const ONE = constants.One
const destinationChainId = 56

const amountIn = utils.parseUnits('5', 18)
const amountOut = utils.parseUnits('4', 6)

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(node_url('polygon'))
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = SynapseBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Swap and Bridge Non-Native Asset
  // Swap DAI -> USDC on Uniswap
  // Bridge USDC -> BUSD via Synapse
  {
    const path = [POLYGON_DAI_ADDRESS, POLYGON_USDC_ADDRESS]
    const to = LIFI_ADDRESS // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const uniswap = new Contract(
      UNISWAP_ADDRESS,
      [
        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
      ],
      wallet
    )

    // Generate swap calldata

    const dexSwapData =
      await uniswap.populateTransaction.swapTokensForExactTokens(
        amountOut,
        amountIn,
        path,
        to,
        deadline
      )
    const swapData = [
      {
        callTo: <string>dexSwapData.to,
        approveTo: <string>dexSwapData.to,
        sendingAssetId: POLYGON_DAI_ADDRESS,
        receivingAssetId: POLYGON_USDC_ADDRESS,
        fromAmount: amountIn,
        callData: <string>dexSwapData?.data,
        requiresDeposit: true,
      },
    ]

    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'synapse',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: POLYGON_USDC_ADDRESS,
      receiver: walletAddress,
      minAmount: amountOut,
      destinationChainId: destinationChainId,
      hasSourceSwaps: true,
      hasDestinationCall: false,
    }

    // Need to get synapse data even when bridge to same token
    const synapseData = await getSynapseDataQueries(
      'polygon',
      'bsc',
      POLYGON_USDC_ADDRESS,
      BSC_BUSD_ADDRESS,
      amountOut,
      0.05, // Slippage
      deadline // Deadline
    )

    // Approve ERC20 for swapping -- DAI -> USDC
    const dai = ERC20__factory.connect(POLYGON_DAI_ADDRESS, wallet)
    const allowance = await dai.allowance(walletAddress, LIFI_ADDRESS)
    if (amountIn.gt(allowance)) {
      await dai.approve(LIFI_ADDRESS, amountIn)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaSynapseBridge(
      bridgeData,
      swapData,
      synapseData,
      {
        gasLimit: 500000,
      }
    )
  }

  // Bridge Native Asset
  {
    const amount = utils.parseEther('0.1')
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'synapse',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: ZERO_ADDRESS,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    // Need to get synapse data even when bridge to same token
    const synapseData = await getSynapseDataQueries(
      'polygon',
      'bsc',
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      amount,
      0.05, // Slippage
      deadline // Deadline
    )

    // Call LiFi smart contract to start the bridge process
    await lifi.startBridgeTokensViaSynapseBridge(bridgeData, synapseData, {
      value: amount,
      gasLimit: 500000,
    })
  }
}

async function getSynapseDataQueries(
  srcChain: string,
  dstChain: string,
  srcToken: string,
  dstToken: string,
  amount: BigNumberish,
  slippage: BigNumberish,
  deadline: BigNumberish
) {
  interface ConfigInfo {
    [network: string]: { router: string }
  }

  const NETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

  const srcJsonProvider = new providers.JsonRpcProvider(node_url(srcChain))
  const srcProvider = new providers.FallbackProvider([srcJsonProvider])
  const dstJsonProvider = new providers.JsonRpcProvider(node_url(dstChain))
  const dstProvider = new providers.FallbackProvider([dstJsonProvider])

  const srcSynapseRouter = ISynapseRouter__factory.connect(
    (config as ConfigInfo)[srcChain].router,
    srcProvider
  )
  const dstSynapseRouter = ISynapseRouter__factory.connect(
    (config as ConfigInfo)[dstChain].router,
    dstProvider
  )

  const dstBridgeTokens = await dstSynapseRouter.getConnectedBridgeTokens(
    dstToken == ZERO_ADDRESS ? NETH_ADDRESS : dstToken
  )

  const dstSymbols = dstBridgeTokens.map((token) => token.symbol)

  const originQueries = await srcSynapseRouter.getOriginAmountOut(
    srcToken == ZERO_ADDRESS ? NETH_ADDRESS : srcToken,
    dstSymbols,
    amount
  )

  const requests = dstSymbols.map((value, index) => ({
    symbol: value,
    amountIn: originQueries[index].minAmountOut,
  }))

  const destQueries = await dstSynapseRouter.getDestinationAmountOut(
    requests,
    dstToken == ZERO_ADDRESS ? NETH_ADDRESS : dstToken
  )

  let selectedIndex = 0
  for (let i = 0; i < destQueries.length; i++) {
    if (destQueries[selectedIndex].minAmountOut < destQueries[i].minAmountOut) {
      selectedIndex = i
    }
  }

  const originQuery = originQueries[selectedIndex]
  const destQuery = destQueries[selectedIndex]

  return {
    originQuery: {
      swapAdapter: originQuery.swapAdapter,
      tokenOut: originQuery.tokenOut,
      minAmountOut: originQuery.minAmountOut
        .mul(ONE.sub(utils.parseEther(slippage.toString())))
        .div(ONE),
      deadline: deadline,
      rawParams: originQuery.rawParams,
    },
    destQuery: {
      swapAdapter: destQuery.swapAdapter,
      tokenOut: destQuery.tokenOut,
      minAmountOut: destQuery.minAmountOut
        .mul(ONE.sub(utils.parseEther(slippage.toString())))
        .div(ONE),
      deadline: deadline,
      rawParams: destQuery.rawParams,
    },
  }
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
