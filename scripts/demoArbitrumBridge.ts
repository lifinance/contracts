import {
  providers,
  Wallet,
  utils,
  constants,
  Contract,
  BigNumber,
} from 'ethers'
import { L1ToL2MessageGasEstimator } from '@arbitrum/sdk/dist/lib/message/L1ToL2MessageGasEstimator'
import { RetryableDataTools } from '@arbitrum/sdk'
import { ArbitrumBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

// Test process

// Bridge Non-Native Asset
// Approve TEST for LiFiDiamond for swapping
// Swap TEST -> USDC via uniswap on Goerli
// Bridge USDC on Goerli -> USDC on Arbitrum Goerli via Arbitrum Native Bridge

// Bridge Native Asset
// Bridge ETH on Goerli -> ETH on Arbitrum Goerli via Arbitrum Native Bridge

const LIFI_ADDRESS = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' // LiFiDiamond address on Goerli
const USDC_ADDRESS = '0x98339D8C260052B7ad81c28c16C0b98420f2B46a' // USDC address on Goerli
const TEST_TOKEN_ADDRESS = '0x7ea6eA49B0b0Ae9c5db7907d139D9Cd3439862a1' // TEST Token address on Goerli
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // Uniswap router address on Goerli
const destinationChainId = 421613 // Arbitrum Goerli chain id
const amountIn = utils.parseEther('1050')
const amountOut = utils.parseUnits('1000', 6)

const {
  gasLimit: errorTriggerGasLimit,
  maxFeePerGas: errorTriggerMaxFeePerGas,
} = RetryableDataTools.ErrorTriggeringParams
const errorTriggerArbitrumData = {
  maxSubmissionCost: 1,
  maxGas: errorTriggerGasLimit,
  maxGasPrice: errorTriggerMaxFeePerGas,
}
const errorTriggerCost = BigNumber.from(1).add(
  errorTriggerGasLimit.mul(errorTriggerMaxFeePerGas)
)

async function main() {
  const l1JsonProvider = new providers.JsonRpcProvider(node_url('goerli'))
  const l1Provider = new providers.FallbackProvider([l1JsonProvider])
  const l2JsonProvider = new providers.JsonRpcProvider(
    node_url('arbitrum_goerli')
  )
  const l2Provider = new providers.FallbackProvider([l2JsonProvider])

  const gasEstimator = new L1ToL2MessageGasEstimator(l2Provider)

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(l1Provider)
  const walletAddress = await wallet.getAddress()

  const lifi = ArbitrumBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge Non-Native Asset
  {
    const token = ERC20__factory.connect(TEST_TOKEN_ADDRESS, wallet)

    // Setting Swap Data
    const uniswap = new Contract(UNISWAP_ADDRESS, [
      'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    ])

    const path = [TEST_TOKEN_ADDRESS, USDC_ADDRESS]
    const to = LIFI_ADDRESS // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

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
        sendingAssetId: TEST_TOKEN_ADDRESS,
        receivingAssetId: USDC_ADDRESS,
        fromAmount: amountIn,
        callData: <string>dexSwapData?.data,
        requiresDeposit: true,
      },
    ]

    // LIFI Data
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'arbitrum',
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: USDC_ADDRESS,
      receiver: walletAddress,
      minAmount: amountOut,
      destinationChainId: destinationChainId,
      hasSourceSwaps: true,
      hasDestinationCall: false,
    }

    const depositFunc = (_: any) => {
      return {
        data: ArbitrumBridgeFacet__factory.createInterface().encodeFunctionData(
          'swapAndStartBridgeTokensViaArbitrumBridge',
          [bridgeData, swapData, errorTriggerArbitrumData]
        ),
        to: lifi.address,
        from: walletAddress,
        value: errorTriggerCost,
      }
    }

    // Approve ERC20 for swapping -- USDC -> USDC
    const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
    if (amountIn.gt(allowance)) {
      await token.approve(LIFI_ADDRESS, amountIn)

      msg('Token approved for swapping')
    }

    const estimates = await gasEstimator.populateFunctionParams(
      depositFunc,
      l1Provider
    )

    const { maxSubmissionCost, gasLimit, maxFeePerGas } = estimates.estimates

    // Total cost
    const cost = maxSubmissionCost.add(maxFeePerGas.mul(gasLimit))

    // Bridge Data
    const arbitrumData = {
      maxSubmissionCost: maxSubmissionCost,
      maxGas: gasLimit,
      maxGasPrice: maxFeePerGas,
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaArbitrumBridge(
      bridgeData,
      swapData,
      arbitrumData,
      {
        gasLimit: '500000',
        value: cost,
      }
    )
  }

  // Bridge Native Asset
  {
    // Bridge amount
    const amount = utils.parseEther('0.0001')

    // LIFI Data
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'arbitrum',
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const depositFunc = (_: any) => {
      return {
        data: ArbitrumBridgeFacet__factory.createInterface().encodeFunctionData(
          'startBridgeTokensViaArbitrumBridge',
          [bridgeData, errorTriggerArbitrumData]
        ),
        to: lifi.address,
        from: walletAddress,
        value: amount.add(errorTriggerCost),
      }
    }

    const estimates = await gasEstimator.populateFunctionParams(
      depositFunc,
      l1Provider
    )

    const {
      maxSubmissionCost,
      gasLimit: gasLimit,
      maxFeePerGas: maxGasPrice,
    } = estimates.estimates

    // Bridge Data
    const arbitrumData = {
      maxSubmissionCost: maxSubmissionCost,
      maxGas: gasLimit,
      maxGasPrice: maxGasPrice,
    }

    // Total cost
    const cost = maxSubmissionCost.add(maxGasPrice.mul(gasLimit))

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.startBridgeTokensViaArbitrumBridge(bridgeData, arbitrumData, {
      gasLimit: '500000',
      value: amount.add(cost),
    })
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
