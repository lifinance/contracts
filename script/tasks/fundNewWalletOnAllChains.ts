import { defineCommand, runMain } from 'citty'
import { parseAbi } from 'viem'
import * as chains from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

import globalConfig from '../../config/global.json'
import { getAllNetworks, getViemChainForNetworkName } from '../../utils/network'
import gasZipChainIds from '../resources/gasZipChainIds.json'
import { BigNumber, BigNumberish } from 'ethers'
import { getGasPrice } from 'viem/actions'
import axios from 'axios'

const MAX_BATCH_SIZE_MULTICALLS = 500 // the max amount of multicalls we do in one call
const MIN_USD_THRESHOLD_BALANCE_TRANSFER = 5 // balances must be worth more than 5 USD, otherwise we leave them
const ADDRESS_USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ADDRESS_WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ADDRESS_MULTICALL3_ETH = '0xcA11bde05977b3631167028862bE2a173976CA11'
const BALANCE_OF_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
])

const testnets = [
  'bsc-testnet',
  'lineatest',
  'mumbai',
  'sepolia',
  'localanvil',
  'virtualtestnet',
]

/// TYPES ///
type HexString = `0x${string}`

type GasZipChainIds = {
  [key: string]: {
    networkName: string
    gasZipChainId: number
  }
}

// this script assumes to be run on mainnet
// it will get a list of all networks we support (minus testnets) and send an equal USD
// amount of native tokens to each of these networks
// afterwards it will check balances on each network
const main = defineCommand({
  meta: {
    name: 'fund-new-wallet-on-all-chains',
    description:
      'Funds a wallet with equal value of native gas on all supported chains',
  },
  args: {
    privKeyFundingWallet: {
      type: 'string',
      description: 'Private key of the source wallet',
      required: true,
    },
    newWallet: {
      type: 'string',
      description: 'Address of the receiving wallet',
      required: true,
    },
    doNotFundChains: {
      type: 'string',
      description: 'An array with chainIds that should not be funded',
      required: true,
    },
    fundAmountUSD: {
      type: 'string',
      description: 'The amount of USD that should be sent to every chain',
      required: true,
    },
  },
  async run({ args }) {
    const { privKeyFundingWallet, newWallet, doNotFundChains, fundAmountUSD } =
      args
    const fundingWalletAddress = privateKeyToAccount(
      `0x${privKeyFundingWallet}` as HexString
    )

    console.log(`fundingWalletAddress: ${fundingWalletAddress.address}`)
    console.log(`newWallet: ${newWallet}`)
    console.log(`pauserWallet: ${globalConfig.pauserWallet}`)
    console.log(`doNotFundChains: ${doNotFundChains}`)
    console.log(`fundAmountUSD: ${fundAmountUSD}`)

    // get a list of all target networks
    const networks = getAllTargetNetworks()
    console.log(`${networks.length} target networks identified`)

    // calculate total amount USD needed (fundAmount * networks)
    const amountUSDPerNetwork = BigNumber.from(fundAmountUSD)

    const amountRequiredUSD = amountUSDPerNetwork.mul(networks.length)
    console.log(`USD amount required: $ ${amountRequiredUSD.toString()}`)

    // get current native price and calculate nativeAmount required
    const ethPrice = Math.round(await getEthPrice())
    console.log(`Current ETH price: $${ethPrice}`)
    // const amountRequiredNative = amountRequiredUSD.div(ethPrice)
    const amountRequiredNative = getNativeAmountRequired(
      amountRequiredUSD,
      ethPrice,
      10
    )
    console.log(`native amount required: ${amountRequiredNative.toString()}`)

    // check if balance fundingWallet sufficient
    // const balance =

    // prepare calldata (get list of gasZip chainIds and combine them)
    // const chainsBN = [51, 52, 56, 16].reduce(
    //   (p, c) => (p << BigInt(8)) + BigInt(c),
    //   BigInt(0)
    // )

    // wait a little

    // check balances in all networks
  },
})

const getNativeAmountRequired = (
  dividend: BigNumberish,
  divisor: BigNumberish,
  precision: number
): BigNumber => {
  // calculate division result with precision
  const multiplier = BigNumber.from(10).pow(precision)
  const decimalResult = BigNumber.from(dividend).mul(multiplier).div(divisor)

  // adjust the scale to 10 ** 8
  const scaleFactor = BigNumber.from(10).pow(8)
  const nativeAmount = decimalResult.mul(scaleFactor).div(multiplier)

  console.log(`nativeAmount: ${nativeAmount.toString()}`)

  return nativeAmount
}

// Function to get ETH price from CoinGecko
const getEthPrice = async () => {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    )
    const ethPrice = response.data.ethereum.usd
    // console.log(`Current ETH price: $${ethPrice}`)
    return ethPrice
  } catch (error) {
    console.error('Error fetching ETH price:', error)
    throw error
  }
}

const getAllTargetNetworks = () => {
  // get a list of all target networks
  const allNetworks = getAllNetworks()

  console.log(`-------------------------------------------`)
  console.log(`\n\nallNetworks(${allNetworks.length}):`)
  console.log(`${JSON.stringify(allNetworks, null, 2)}`)

  // remove testnets
  const allProdNetworks = allNetworks.filter(
    (network) => !testnets.includes(network)
  )
  console.log(`-------------------------------------------`)
  console.log(`\n\nallProdNetworks (${allProdNetworks.length}):`)
  console.log(`${JSON.stringify(allProdNetworks, null, 2)}`)

  const allViemNetworks = allProdNetworks.map((network) => {
    const chain = getViemChainForNetworkName(network)
    return {
      ...chain,
      nameLiFi: network,
    }
  })

  console.log(`-------------------------------------------`)
  console.log(`\n\nallViemNetworks(${allViemNetworks.length}):`)
  // console.log(`${JSON.stringify(allViemNetworks, null, 2)}`)

  // identify networks that gasZip does not support
  const gasZipChainIdsTyped: GasZipChainIds = gasZipChainIds
  const unsupportedNetworks = allViemNetworks.filter(
    (network) => !gasZipChainIdsTyped[network.id.toString()]
  )
  console.log(`-------------------------------------------`)
  console.log(`\n\nunsupportedNetworks(${unsupportedNetworks.length}):`)
  console.log(
    `${JSON.stringify(
      unsupportedNetworks.map((network) => `${network.name}:${network.id}`),
      null,
      2
    )}`
  )

  // identify networks that gasZip does not support
  const targetNetworks = allProdNetworks
    .map((network) => getViemChainForNetworkName(network))
    .filter((network) => network)
  // .filter((network) => null)

  console.log(`-------------------------------------------`)
  console.log(`\n\ntargetNetworks:(${targetNetworks.length})`)
  // console.log(`${JSON.stringify(targetNetworks, null, 2)}`)

  return targetNetworks
}

runMain(main)
