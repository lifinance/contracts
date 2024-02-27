import { providers, Wallet, utils, constants, Contract } from 'ethers'
import { HopFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../../utils/network'
import * as deployment from '../export/deployments-staging.json'
import { Chain, Hop } from '@hop-protocol/sdk'
import { parseUnits } from 'ethers/lib/utils'
import chalk from 'chalk'

const log = (msg: string) => {
  console.log(chalk.green(msg))
}

// const LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address
// const POLYGON_USDT_ADDRESS = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
// const POLYGON_USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
// const UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
// const amountToSwap = '2'
// const destinationChainId = 100

async function main() {
  // get wallet
  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  const provider = new providers.JsonRpcProvider(node_url('polygon'))
  wallet = wallet.connect(provider)

  // get Permit2Proxy contract
  const lifi = HopFacet__factory.connect(LIFI_ADDRESS, wallet)
  const bridge = hop.connect(provider).bridge('USDC')

  // get quote from LIFI API/SDK

  // sign quote/calldata using wallet

  // trigger transaction using calldata and user signature

  let HopData

  if (process.argv.includes('--swap')) {
    log('Swap + bridge')

    const amountIn = parseUnits('2', 6)
    const amountOut = parseUnits('2', 6)

    log('Getting Hop info...')
    const fee = await bridge.getTotalFee(amountOut, Chain.Polygon, Chain.Gnosis)

    const path = [POLYGON_USDT_ADDRESS, POLYGON_USDC_ADDRESS]
    const to = LIFI_ADDRESS // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 120 // 2 hours from the current Unix time

    const uniswap = new Contract(
      UNISWAP_ADDRESS,
      [
        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
      ],
      wallet
    )

    // Test for swapAndStartBridgeTokensViaCBridge
    // Generate swap calldata

    const swapData = await uniswap.populateTransaction.swapTokensForExactTokens(
      amountOut,
      amountIn,
      path,
      to,
      deadline
    )

    const token = ERC20__factory.connect(POLYGON_USDC_ADDRESS, wallet)
    // Approve ERC20 for swapping -- USDT -> USDC
    await token.approve(lifi.address, amountIn)

    log('Token approved for swapping')

    const lifiData = {
      transactionId: utils.randomBytes(32),
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: POLYGON_USDC_ADDRESS,
      receivingAssetId: POLYGON_USDT_ADDRESS,
      receiver: await wallet.getAddress(),
      destinationChainId: destinationChainId,
      amount: amountOut.toString(),
    }

    HopData = {
      asset: 'USDC',
      chainId: destinationChainId,
      recipient: await wallet.getAddress(),
      amount: parseUnits('0.05', 6),
      bonderFee: fee,
      amountOutMin: parseUnits('0.04', 6),
      deadline,
      destinationAmountOutMin: parseUnits('0.03', 6),
      destinationDeadline: deadline,
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    log('Sending...')
    const tx = await lifi.swapAndStartBridgeTokensViaHop(
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
      HopData,
      { gasLimit: 900000 }
    )

    log(tx.hash)

    const receipt = await tx.wait()

    log(receipt.status ? 'SUCCESS' : 'REVERTED')
  } else {
    log('Bridge without swap')
    const token = ERC20__factory.connect(POLYGON_USDC_ADDRESS, wallet)
    const amount = utils.parseUnits(amountToSwap, 6)

    await token.approve(lifi.address, amount)

    log('Getting Hop info...')
    const fee = await bridge.getTotalFee(amount, Chain.Polygon, Chain.Gnosis)

    const deadline = Math.floor(Date.now() / 1000) + 60 * 120 // 2 hours from the current Unix time

    const lifiData = {
      transactionId: utils.randomBytes(32),
      integrator: 'ACME Devs',
      referrer: constants.AddressZero,
      sendingAssetId: token.address,
      receivingAssetId: token.address,
      receiver: await wallet.getAddress(),
      destinationChainId: destinationChainId,
      amount: amount.toString(),
    }

    HopData = {
      asset: 'USDC',
      chainId: destinationChainId,
      recipient: await wallet.getAddress(),
      amount: amount,
      bonderFee: fee,
      amountOutMin: parseUnits('0.9', 6),
      deadline,
      destinationAmountOutMin: parseUnits('0.8', 6),
      destinationDeadline: deadline,
    }

    log('Sending...')

    const tx = await lifi.startBridgeTokensViaHop(lifiData, HopData, {
      gasLimit: 500000,
    })

    log(tx.hash)

    const receipt = await tx.wait()

    log(receipt.status ? 'SUCCESS' : 'REVERTED')
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
