import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { AmarokFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import config from '../config/amarok'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

// Test process

// Bridge Non-Native Asset
// Approve USDC for LiFiDiamond for swapping
// Swap USDC -> TestToken via uniswap on Goerli
// Bridge TestToken on Goerli -> TestToken on Optimism Goerli via Connext Amarok

const LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0' // LiFiDiamond address on Goerli
const GOERLI_TOKEN_ADDRESS = '0x7ea6eA49B0b0Ae9c5db7907d139D9Cd3439862a1' // TestToken address on Goerli
const OPTIMISM_GOERLI_TOKEN_ADDRESS =
  '0x68Db1c8d85C09d546097C65ec7DCBFF4D6497CbF' // TestToken address on Optimism Goerli
const GOERLI_USDC_ADDRESS = '0x98339D8C260052B7ad81c28c16C0b98420f2B46a' // USDC address on Goerli
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // Uniswap router address on Goerli
const SRC_CHAIN = 'goerli' // Sending chain
const DST_CHAIN = 'optimism_goerli' // Destination chain
const destinationChainId = 420 // Optimism Goerli chain id
const amountIn = utils.parseUnits('1020', 6)
const amountOut = utils.parseEther('1000')

async function main() {
  const jsonRpcProvider = new providers.JsonRpcProvider(node_url(SRC_CHAIN))
  const srcChainProvider = new providers.FallbackProvider([jsonRpcProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(srcChainProvider)
  const walletAddress = await wallet.getAddress()

  const lifi = AmarokFacet__factory.connect(LIFI_ADDRESS, wallet)

  const token = ERC20__factory.connect(GOERLI_USDC_ADDRESS, wallet)

  // Setting Swap Data
  const uniswap = new Contract(UNISWAP_ADDRESS, [
    'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])

  const path = [GOERLI_USDC_ADDRESS, GOERLI_TOKEN_ADDRESS]
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
    sendingAssetId: GOERLI_USDC_ADDRESS,
    receivingAssetId: OPTIMISM_GOERLI_TOKEN_ADDRESS,
    receiver: walletAddress,
    destinationChainId: destinationChainId,
    amount: amountOut,
  }

  // Bridge Data
  const bridgeData = {
    connextHandler: config[SRC_CHAIN].connextHandler,
    assetId: GOERLI_TOKEN_ADDRESS,
    srcChainDomain: config[SRC_CHAIN].domain,
    dstChainDomain: config[DST_CHAIN].domain,
    receiver: walletAddress,
    amount: amountOut,
    callData: '0x',
    forceSlow: false,
    receiveLocal: false,
    callback: constants.AddressZero,
    callbackFee: 0,
    relayerFee: 0,
    slippageTol: 9995, // 9995 to tolerate .05% slippage
    originMinOut: 0,
  }

  // Approve ERC20 for swapping -- USDC -> TestToken
  const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
  if (amountIn.gt(allowance)) {
    await token.approve(lifi.address, amountIn)

    msg('Token approved for swapping')
  }

  // Call LiFi smart contract to start the bridge process -- WITH SWAP
  await lifi.swapAndStartBridgeTokensViaAmarok(
    lifiData,
    [
      {
        callTo: <string>swapData.to,
        approveTo: <string>swapData.to,
        sendingAssetId: GOERLI_USDC_ADDRESS,
        receivingAssetId: GOERLI_TOKEN_ADDRESS,
        callData: <string>swapData?.data,
        fromAmount: amountIn,
      },
    ],
    bridgeData,
    {
      gasLimit: '1000000',
    }
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
