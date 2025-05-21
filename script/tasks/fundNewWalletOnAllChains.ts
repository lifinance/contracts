import { defineCommand, runMain } from 'citty'
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { BigNumber, BigNumberish } from 'ethers'
import axios from 'axios'
import {
  getAllActiveNetworks,
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'

const GAS_ZIP_ROUTER_MAINNET = '0x9e22ebec84c7e4c4bd6d4ae7ff6f4d436d6d8390'

/// TYPES ///
type HexString = `0x${string}`

type GasZipChainIds = {
  [key: string]: {
    networkName: string
    gasZipChainId: number
  }
}

// this script is designed to be executed on mainnet (only)
// it will get a list of all networks we support (minus testnets) and send an equal USD
// amount worth of native tokens to each of these target networks using Gas.zip protocol

// call this script
// bun ./script/tasks/fundNewWalletOnAllChains.ts --privKeyFundingWallet "$PRIVATE_KEY" --receivingWallet "$PAUSER_WALLET" --doNotFundChains "[97,80001]" --fundAmountUSD "5"

const main = defineCommand({
  meta: {
    name: 'fund-new-wallet-on-all-chains',
    description:
      'Funds a wallet with equal value of native gas on all supported chains',
  },
  args: {
    privKeyFundingWallet: {
      type: 'string',
      description: 'Private key of the funding wallet',
      required: true,
    },
    receivingWallet: {
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
    const {
      privKeyFundingWallet,
      receivingWallet,
      doNotFundChains,
      fundAmountUSD,
    } = args
    const fundingWallet = privateKeyToAccount(
      `0x${privKeyFundingWallet}` as HexString
    )

    console.log(`fundingWalletAddress: ${fundingWallet.address}`)
    console.log(`receivingWallet: ${receivingWallet}`)
    console.log(`doNotFundChains: ${doNotFundChains}`)
    console.log(`fundAmountUSD: ${fundAmountUSD}\n`)

    // get viem public client to read from blockchain
    const viemChainMainnet = getViemChainForNetworkName('mainnet')
    const publicClient = createPublicClient({
      chain: viemChainMainnet,
      transport: http(),
    })

    // create wallet client to write to chain
    const walletClient = createWalletClient({
      chain: viemChainMainnet,
      transport: http(),
      account: fundingWallet,
    })

    // get a list of all target networks
    const networks = getGasZipSupportedActiveNetworks()

    // calculate total amount USD needed (fundAmount * networks)
    const amountUSDPerNetwork = BigNumber.from(fundAmountUSD)
    const amountRequiredUSD = amountUSDPerNetwork.mul(networks.length)
    console.log(
      `USD amount required to fund all networks: $ ${amountRequiredUSD.toString()}\n`
    )

    // get current native price and calculate nativeAmount required
    const ethPrice = Math.round(await getEthPrice())
    console.log(`Current ETH price: $${ethPrice}`)
    // const amountRequiredNative = amountRequiredUSD.div(ethPrice)
    const amountRequiredNative = getNativeAmountRequired(
      amountRequiredUSD,
      ethPrice,
      10
    )
    console.log(
      `Native amount required to fund all networks: ${amountRequiredNative.toString()}\n`
    )

    // get fundingWallet's native balance
    const nativeBalance = BigNumber.from(
      await publicClient.getBalance({
        address: fundingWallet.address,
      })
    )

    // make sure that balance is sufficient
    if (nativeBalance.lt(amountRequiredNative))
      throw new Error(
        `Native balance of funding wallet is insufficient: \nrequired : ${amountRequiredNative}, \navailable: ${nativeBalance}`
      )
    else
      console.log(
        'Funding wallet native balance is sufficient for this action: \nbalance: ${nativeBalance}, \nrequired: ${amountRequiredNative}'
      )

    // get an array with target chainIds
    const chainIds = networks.map((chain) => chain.gasZipChainId)
    console.log(`ChainIds: [${chainIds}]`)

    // prepare calldata (get list of gasZip chainIds and combine them)
    const chainsBN = chainIds.reduce(
      (p, c) => (p << BigInt(8)) + BigInt(c),
      BigInt(0)
    )
    console.log(`DestinationChainsValue: ${chainsBN}`)

    // Get the latest block information to get the base fee
    const gasFees = await publicClient.estimateFeesPerGas()

    // @DEV: when this script was used the last time this gas estimation was required in order to get the transaction submitted to mainnet
    //       the data parameter was hardcoded, this should be improved if this code is required permanently
    //       consider using this: https://viem.sh/docs/contract/estimateContractGas#estimatecontractgas
    // const gas = await publicClient.estimateGas({
    //   account: fundingWallet,
    //   to: GAS_ZIP_ROUTER_MAINNET,
    //   value: amountRequiredNative.toBigInt(),
    //   data: '0x6e553f6500000000ff393e0f36608c9415140a1f103b0d1e491c1d371134fe29f6f99233000000000000000000000000d38743b48d26743c0ec6898d699394fbc94657ee',
    // })
    // console.log(`Gas estimated: ${gas}`)

    // simulate transaction
    const result = await publicClient.simulateContract({
      account: fundingWallet,
      address: GAS_ZIP_ROUTER_MAINNET,
      abi: parseAbi(['function deposit(uint256,address) external payable']),
      functionName: 'deposit',
      value: amountRequiredNative.toBigInt(),
      args: [chainsBN, receivingWallet as HexString],
      // gas: gas,
    })
    console.dir(result, { depth: null, colors: true })

    // execute transaction
    const txHash = await walletClient.writeContract({
      ...result.request,
    })
    console.log(`Transaction successfully submitted: ${txHash}`)

    const transaction = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })
    console.dir(transaction, { depth: null, colors: true })
  },
})

const getNativeAmountRequired = (
  dividend: BigNumberish,
  divisor: BigNumberish,
  precision: number
): BigNumber => {
  if (precision > 10) throw new Error('max precision is 10 decimals')
  // calculate division result with precision
  const multiplier = BigNumber.from(10).pow(precision)
  const decimalResult = BigNumber.from(dividend).mul(multiplier).div(divisor)

  // adjust the amount to 10 ** 18
  const scaleFactor = BigNumber.from(10).pow(18 - precision)
  const nativeAmount = decimalResult.mul(scaleFactor)

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

const getGasZipSupportedActiveNetworks = () => {
  const activeNetworks = getAllActiveNetworks()
  console.log(
    `${activeNetworks.length} active networks identified: ${activeNetworks.map(
      (network) => network.id
    )}\n`
  )

  // remove testnets
  const mainnets = activeNetworks.filter(
    (network) => network.type === 'mainnet'
  )

  console.log(`${mainnets.length} of those networks are mainnets\n`)

  // identify and remove networks that do not have a GasZipChainId
  const gasZipSupportedNetworks = mainnets.filter(
    (network) => network.gasZipChainId !== 0
  )
  const gasZipUnsupportedNetworks = mainnets.filter(
    (network) => network.gasZipChainId === 0
  )

  // print all networks that are not supported by GasZip and need to be funded manually
  if (gasZipUnsupportedNetworks.length) {
    console.warn(
      `The following ${
        gasZipUnsupportedNetworks.length
      } networks are not supported by GasZip and need to be funded manually: ${JSON.stringify(
        gasZipUnsupportedNetworks.map((chain) => chain.id),
        null,
        2
      )}\n`
    )
  }

  console.log(
    `${gasZipSupportedNetworks.length} of those networks are supported by GasZip\n`
  )

  return gasZipSupportedNetworks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

runMain(main)
