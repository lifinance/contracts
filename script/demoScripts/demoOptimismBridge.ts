import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { OptimismBridgeFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import config from '../config/optimism'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

// Test process

// Bridge Non-Native Asset
// Approve USDT for LiFiDiamond for swapping
// Swap USDT -> DAI via uniswap on Kovan
// Bridge DAI on Kovan -> DAI on Optimism Kovan via Optimism Native Bridge

// Bridge Native Asset
// Bridge ETH on Kovan -> ETH on Optimism Kovan via Optimism Native Bridge

const LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0' // LiFiDiamond address on Kovan
const DAI_L1_ADDRESS = '0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa' // DAI address on Kovan
const USDT_TOKEN_ADDRESS = '0x07de306ff27a2b630b1141956844eb1552b956b5' // USDT address on Kovan
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // Uniswap router address on Kovan
const SRC_CHAIN = 'kovan' // Sending chain
const CONFIG = config[SRC_CHAIN] // Configuration for sending chain
const L2_GAS = 200000 // L2 Gas, Don't need to change it.
const destinationChainId = 69 // Optimism Kovan chain id
const amountIn = utils.parseUnits('3', 6)
const amountOut = utils.parseEther('2')

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(node_url(SRC_CHAIN))
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = OptimismBridgeFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge Non-Native Asset
  {
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

    // Get l2Token address from configuration
    const l1Token = DAI_L1_ADDRESS.toLowerCase()
    const l2Token = (CONFIG.tokens || {})[l1Token] || constants.AddressZero

    // LIFI Data
    const lifiData = {
      transactionId: utils.randomBytes(32),
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: USDT_TOKEN_ADDRESS,
      receivingAssetId: l2Token,
      receiver: walletAddress,
      destinationChainId: destinationChainId,
      amount: amountOut,
    }

    // Bridge Data
    const bridgeData = {
      assetId: DAI_L1_ADDRESS,
      assetIdOnL2: l2Token,
      amount: amountOut,
      receiver: walletAddress,
      bridge: CONFIG.bridges[l1Token] || CONFIG.bridges.standardBridge,
      l2Gas: L2_GAS,
      isSynthetix: l1Token == CONFIG.snxToken,
    }

    // Approve ERC20 for swapping -- USDC -> DAI
    const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
    if (amountIn.gt(allowance)) {
      await token.approve(lifi.address, amountIn)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaOptimismBridge(
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
    const amount = utils.parseEther('0.0001')

    // LIFI Data
    const lifiData = {
      transactionId: utils.randomBytes(32),
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receivingAssetId: constants.AddressZero,
      receiver: walletAddress,
      destinationChainId: destinationChainId,
      amount: amount,
    }

    // Bridge Data
    const bridgeData = {
      assetId: constants.AddressZero,
      assetIdOnL2: constants.AddressZero,
      amount: amount,
      receiver: walletAddress,
      bridge: CONFIG.bridges.standardBridge,
      l2Gas: L2_GAS,
      isSynthetix: false,
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.startBridgeTokensViaOptimismBridge(lifiData, bridgeData, {
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
