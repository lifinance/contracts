import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { OmniBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import config, {
  BRIDGED_TOKEN_ADDRESS_ABI,
  WETH_ADDRESS_ABI,
} from '../config/omni'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

// Test process

// Bridge Non-Native Asset
// Approve USDT for LiFiDiamond for swapping
// Swap USDT -> DAI via uniswap on Kovan
// Bridge DAI on Kovan -> DAI on POA Sokol via Foreign Omni Bridge

// Bridge Native Asset
// Bridge ETH on Kovan -> ETH on POA Sokol via WETH Omni Bridge

const LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0' // LiFiDiamond address on Kovan
const DAI_L1_ADDRESS = '0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa' // DAI address on Kovan
const USDT_TOKEN_ADDRESS = '0x07de306ff27a2b630b1141956844eb1552b956b5' // USDT address on Kovan
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // Uniswap router address on Kovan
const SRC_CHAIN = 'kovan' // Sending chain
const DST_CHAIN = 'sokol' // Sending chain
const destinationChainId = 77 // POA Sokol chain id
const amountIn = utils.parseUnits('0.05', 6)
const amountOut = utils.parseEther('2')

async function main() {
  const srcChainProvider1 = new providers.JsonRpcProvider(node_url(SRC_CHAIN))
  const srcChainProvider = new providers.FallbackProvider([srcChainProvider1])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(srcChainProvider)
  const walletAddress = await wallet.getAddress()

  const dstChainProvider1 = new providers.JsonRpcProvider(node_url(DST_CHAIN))
  const dstChainProvider = new providers.FallbackProvider([dstChainProvider1])

  const homeOmniBridge = new Contract(
    config[SRC_CHAIN].homeOmniBridge,
    BRIDGED_TOKEN_ADDRESS_ABI,
    dstChainProvider
  )

  const lifi = OmniBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge Non-Native Asset
  {
    const l2Address = await homeOmniBridge.bridgedTokenAddress(DAI_L1_ADDRESS)

    const token = ERC20__factory.connect(USDT_TOKEN_ADDRESS, wallet)

    // Setting Swap Data
    const uniswap = new Contract(UNISWAP_ADDRESS, [
      'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    ])

    const path = [USDT_TOKEN_ADDRESS, DAI_L1_ADDRESS]
    const to = LIFI_ADDRESS // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const swapData = await uniswap.populateTransaction.swapTokensForExactTokens(
      amountOut,
      amountIn,
      path,
      to,
      deadline
    )

    // LIFI Data
    const lifiData = {
      transactionId: utils.randomBytes(32),
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: USDT_TOKEN_ADDRESS,
      receivingAssetId: l2Address,
      receiver: walletAddress,
      destinationChainId: destinationChainId,
      amount: amountOut,
    }

    // Bridge Data
    const bridgeData = {
      assetId: DAI_L1_ADDRESS,
      amount: amountOut,
      receiver: walletAddress,
      bridge: config[SRC_CHAIN].foreignOmniBridge,
    }

    // Approve ERC20 for swapping -- USDC -> DAI
    const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
    if (amountIn.gt(allowance)) {
      await token.approve(lifi.address, amountIn)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaOmniBridge(
      lifiData,
      [
        {
          sendingAssetId: USDT_TOKEN_ADDRESS,
          approveTo: <string>swapData.to,
          receivingAssetId: DAI_L1_ADDRESS,
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

  // Bridge Native Asset
  {
    // Bridge amount
    const amount = utils.parseEther('1')

    const wethOmniBridge = new Contract(
      config[SRC_CHAIN].wethOmniBridge,
      WETH_ADDRESS_ABI,
      srcChainProvider
    )
    const wethAddress = await wethOmniBridge.WETH()
    const l2Token = await homeOmniBridge.bridgedTokenAddress(wethAddress)

    // LIFI Data
    const lifiData = {
      transactionId: utils.randomBytes(32),
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receivingAssetId: l2Token,
      receiver: walletAddress,
      destinationChainId: destinationChainId,
      amount: amount,
    }

    // Bridge Data
    const bridgeData = {
      assetId: constants.AddressZero,
      amount: amount,
      receiver: walletAddress,
      bridge: config[SRC_CHAIN].wethOmniBridge,
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.startBridgeTokensViaOmniBridge(lifiData, bridgeData, {
      gasLimit: '500000',
      value: amount,
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
