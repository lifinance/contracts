import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { CCIPFacet__factory, ERC20__factory } from '../../typechain'
import chalk from 'chalk'
import dotenv from 'dotenv'

dotenv.config()

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = '0xbEbCDb5093B47Cd7add8211E4c77B6826aF7bc5F' // LiFiDiamond address on MAINNET stating
const R_TOKEN_ADDRESS = '0x183015a9ba6ff60230fdeadc3f43b3d788b13e21'
const R_TOKEN_ADDRESS_BASE = '0xaFB2820316e7Bc5Ef78d295AB9b8Bb2257534576'
const USDC_TOKEN_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UNISWAP_ADDRESS = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43'
const CCIP_MSG_RECEIVER_ADDR = '0x867C971a7411eE369EA18d282Df06393236bAb77'
const L2_GAS = 20000 // L2 Gas, Don't need to change it.
const destinationChainId = 8453 // Base Chain

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(
    process.env.ETH_NODE_URI_MAINNET
  )
  const jsonProvider2 = new providers.JsonRpcProvider(
    process.env.ETH_NODE_URI_BASE
  )
  const provider = new providers.FallbackProvider([jsonProvider])
  const provider2 = new providers.FallbackProvider([jsonProvider2])

  let wallet = new Wallet(<string>process.env.PRIVATE_KEY)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = CCIPFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge amount
  const amount = utils.parseEther('1')

  // LIFI Data
  const lifiData = {
    transactionId: utils.randomBytes(32),
    bridge: 'CCIP',
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: R_TOKEN_ADDRESS,
    receiver: walletAddress,
    minAmount: amount,
    destinationChainId: destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: true,
  }

  // Bridge ERC20
  lifiData.sendingAssetId = R_TOKEN_ADDRESS

  const extraArgs = await lifi.encodeDestinationArgs(1000000, false)

  // Swap Data
  const uniswap = new Contract(UNISWAP_ADDRESS, [
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])
  const path = [R_TOKEN_ADDRESS_BASE, USDC_TOKEN_ADDRESS_BASE]
  const deadline = Math.floor(Date.now() / 1000) + 60 * 45 // 45 minutes from the current Unix time

  const amountOutMin = utils.parseEther('0.99')
  const usdcAmountOutMin = utils.parseUnits('0.95', 6)

  const swapData = await uniswap.populateTransaction.swapExactTokensForTokens(
    amountOutMin,
    usdcAmountOutMin,
    path,
    CCIP_MSG_RECEIVER_ADDR,
    deadline
  )

  const payload = utils.defaultAbiCoder.encode(
    [
      'bytes32',
      'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]',
      'address',
    ],
    [
      lifiData.transactionId,
      [
        {
          callTo: <string>swapData.to,
          approveTo: <string>swapData.to,
          sendingAssetId: R_TOKEN_ADDRESS_BASE,
          receivingAssetId: USDC_TOKEN_ADDRESS_BASE,
          fromAmount: amountOutMin,
          callData: <string>swapData?.data,
          requiresDeposit: true,
        },
      ],
      walletAddress,
    ]
  )

  const bridgeData = {
    callData: payload,
    extraArgs,
    receiver: CCIP_MSG_RECEIVER_ADDR,
  }

  const fee = await lifi.quoteCCIPFee(lifiData, bridgeData)

  msg('Wallet Address: ' + walletAddress)

  msg('Approving R...')
  const BETS = ERC20__factory.connect(R_TOKEN_ADDRESS, wallet)
  let tx = await BETS.approve(LIFI_ADDRESS, amount)
  await tx.wait()

  msg('Sending R to Base via CCIP...')
  tx = await lifi.startBridgeTokensViaCCIP(lifiData, bridgeData, {
    gasLimit: '500000',
    value: fee,
  })
  msg('TX Sent. Waiting for receipt...')
  await tx.wait()
  msg('TX Hash: ' + tx.hash)
  msg('Done!')
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
