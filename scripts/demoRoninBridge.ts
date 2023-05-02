import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { RoninBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0x1D7554F2EF87Faf41f9c678cF2501497D38c014f'
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const ZERO_ADDRESS = constants.AddressZero
const destinationChainId = 2020

const amountIn = utils.parseUnits('5', 18)
const amountOut = utils.parseUnits('4', 6)

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(node_url('mainnet'))
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = RoninBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

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
      bridge: 'ronin',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: USDC_ADDRESS,
      receiver: walletAddress,
      minAmount: amountOut,
      destinationChainId: destinationChainId,
      hasSourceSwaps: true,
      hasDestinationCall: false,
    }

    // Approve ERC20 for swapping -- DAI -> USDC
    const dai = ERC20__factory.connect(DAI_ADDRESS, wallet)
    const allowance = await dai.allowance(walletAddress, LIFI_ADDRESS)
    if (amountIn.gt(allowance)) {
      await dai.approve(LIFI_ADDRESS, amountIn)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaRoninBridge(bridgeData, swapData, {
      gasLimit: 500000,
    })
  }

  // Bridge Native Asset
  {
    const amount = utils.parseEther('0.01')
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'ronin',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: ZERO_ADDRESS,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    // Call LiFi smart contract to start the bridge process
    await lifi.startBridgeTokensViaRoninBridge(bridgeData, {
      value: amount,
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
