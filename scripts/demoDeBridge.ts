import { providers, Wallet, utils, constants, Contract } from 'ethers'
import {
  DeBridgeFacet__factory,
  ERC20__factory,
  IDeBridgeGate__factory,
} from '../typechain'
import { node_url } from '../utils/network'
import chalk from 'chalk'
import { config } from '../config/debridge.json'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0xF0e74c6438bBC9997534860968A59C70223CC53C'
const DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'
const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
const ZERO_ADDRESS = constants.AddressZero
const destinationChainId = 56

const amountIn = utils.parseUnits('5', 18)
const amountOut = utils.parseUnits('4', 6)

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(node_url('polygon'))
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = DeBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  const deBridgeGate = IDeBridgeGate__factory.connect(
    config['polygon'].deBridgeGate,
    provider
  )

  // Swap and Bridge Non-Native Asset
  {
    const path = [DAI_ADDRESS, USDC_ADDRESS]
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
        sendingAssetId: DAI_ADDRESS,
        receivingAssetId: USDC_ADDRESS,
        fromAmount: amountIn,
        callData: <string>dexSwapData?.data,
        requiresDeposit: true,
      },
    ]

    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'debridge',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: USDC_ADDRESS,
      receiver: walletAddress,
      minAmount: amountOut,
      destinationChainId: destinationChainId,
      hasSourceSwaps: true,
      hasDestinationCall: false,
    }

    const chainConfig = await deBridgeGate.getChainToConfig(destinationChainId)
    const nativeFee = chainConfig.fixedNativeFee.isZero()
      ? await deBridgeGate.globalFixedNativeFee()
      : chainConfig.fixedNativeFee

    const deBridgeData = {
      permit: '0x',
      nativeFee: nativeFee,
      useAssetFee: false,
      referralCode: 0,
      autoParams: {
        executionFee: utils.parseUnits('1', 6),
        flags: 1, // REVERT_IF_EXTERNAL_FAIL
        fallbackAddress: walletAddress,
        data: '0x',
      },
    }

    // Approve ERC20 for swapping -- DAI -> USDC
    const dai = ERC20__factory.connect(DAI_ADDRESS, wallet)
    const allowance = await dai.allowance(walletAddress, LIFI_ADDRESS)
    if (amountIn.gt(allowance)) {
      await dai.approve(LIFI_ADDRESS, amountIn)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaDeBridge(
      bridgeData,
      swapData,
      deBridgeData,
      {
        value: nativeFee,
        gasLimit: 500000,
      }
    )
  }

  // Bridge Native Asset
  {
    const amount = utils.parseEther('1')
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'debridge',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: ZERO_ADDRESS,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const chainConfig = await deBridgeGate.getChainToConfig(destinationChainId)
    const nativeFee = chainConfig.fixedNativeFee.isZero()
      ? await deBridgeGate.globalFixedNativeFee()
      : chainConfig.fixedNativeFee

    const deBridgeData = {
      permit: '0x',
      nativeFee: nativeFee,
      useAssetFee: false,
      referralCode: 0,
      autoParams: {
        executionFee: utils.parseEther('0.8'),
        flags: 1, // REVERT_IF_EXTERNAL_FAIL
        fallbackAddress: walletAddress,
        data: '0x',
      },
    }

    // Call LiFi smart contract to start the bridge process
    await lifi.startBridgeTokensViaDeBridge(bridgeData, deBridgeData, {
      value: amount.add(nativeFee),
      gasLimit: 500000,
    })
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
