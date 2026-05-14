import axios from 'axios'
import { defineCommand, runMain } from 'citty'
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import gaszipConfig from '../../config/gaszip.json'
import { getPrivateKey } from '../deploy/safe/safe-utils'
import {
  getAllActiveNetworks,
  getViemChainForNetworkName,
  isTestnetNetwork,
} from '../utils/viemScriptHelpers'

const GAS_ZIP_ROUTER_MAINNET = getAddress(gaszipConfig.gasZipRouters.mainnet)

/// TYPES ///
type HexString = `0x${string}`

// this script is designed to be executed on mainnet (only)
// it will get a list of all networks we support (minus testnets) and send an equal USD
// amount worth of native tokens to each of these target networks using Gas.zip protocol

// call this script
// PRIVATE_KEY_PRODUCTION="..." bunx tsx ./script/tasks/fundNewWalletOnAllChains.ts --receivingWallet "$PAUSER_WALLET" --doNotFundChains "[97,80001]" --fundAmountUSD "5"
// (or pass --privKeyFundingWallet directly to override the env var)

const main = defineCommand({
  meta: {
    name: 'fund-new-wallet-on-all-chains',
    description:
      'Funds a wallet with equal value of native gas on all supported chains',
  },
  args: {
    privKeyFundingWallet: {
      type: 'string',
      description:
        'Private key of the funding wallet (optional; defaults to PRIVATE_KEY_PRODUCTION from .env)',
      required: false,
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
    const fundingPrivateKey = getPrivateKey(
      'PRIVATE_KEY_PRODUCTION',
      privKeyFundingWallet
    )
    const fundingWallet = privateKeyToAccount(`0x${fundingPrivateKey}`)

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

    // parse the excluded chainIds (JSON array of numbers, e.g. "[97,80001]")
    const excludedChainIds = parseExcludedChainIds(doNotFundChains)

    // get a list of all target networks (Gas.zip-supported mainnets, minus excluded)
    const networks = getGasZipSupportedActiveNetworks(excludedChainIds)
    if (networks.length === 0)
      throw new Error(
        'No target networks remaining after applying doNotFundChains filter'
      )

    const USD_DECIMALS = 6
    const MIN_FUND_AMOUNT_USD = parseUnits('0.25', USD_DECIMALS)
    const MAX_FUND_AMOUNT_USD = parseUnits('50', USD_DECIMALS)
    const amountUSDPerNetwork = parseUnits(fundAmountUSD, USD_DECIMALS)
    if (
      amountUSDPerNetwork < MIN_FUND_AMOUNT_USD ||
      amountUSDPerNetwork > MAX_FUND_AMOUNT_USD
    )
      throw new Error(
        `fundAmountUSD must be between $0.25 and $50.00 per chain (Gas.zip per-chain limits, see https://dev.gas.zip/gas/overview). Received: $${fundAmountUSD}`
      )
    const amountRequiredUSD = amountUSDPerNetwork * BigInt(networks.length)
    console.log(
      `USD amount required to fund all networks: $ ${formatUnits(
        amountRequiredUSD,
        USD_DECIMALS
      )}\n`
    )

    const ethPrice = Math.round(await getEthPrice())
    console.log(`Current ETH price: $${ethPrice}`)
    const amountRequiredNative =
      (amountRequiredUSD * 10n ** BigInt(18 - USD_DECIMALS)) / BigInt(ethPrice)
    console.log(
      `Native amount required to fund all networks: ${amountRequiredNative.toString()}\n`
    )

    const nativeBalance = await publicClient.getBalance({
      address: fundingWallet.address,
    })

    if (nativeBalance < amountRequiredNative)
      throw new Error(
        `Native balance of funding wallet is insufficient: \nrequired : ${amountRequiredNative}, \navailable: ${nativeBalance}`
      )
    else
      console.log(
        `Funding wallet native balance is sufficient for this action: \nbalance: ${nativeBalance}, \nrequired: ${amountRequiredNative}`
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
      value: amountRequiredNative,
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

const parseExcludedChainIds = (raw: string): Set<number> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `doNotFundChains must be a JSON array of chainIds, e.g. "[97,80001]". Received: ${raw}`
    )
  }
  if (!Array.isArray(parsed))
    throw new Error(
      `doNotFundChains must be a JSON array of chainIds, e.g. "[97,80001]". Received: ${raw}`
    )
  const chainIds = parsed.map((value) => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new Error(
        `doNotFundChains entries must be integer chainIds. Received: ${JSON.stringify(
          value
        )}`
      )
    return value
  })
  return new Set<number>(chainIds)
}

const getGasZipSupportedActiveNetworks = (excludedChainIds: Set<number>) => {
  const activeNetworks = getAllActiveNetworks()
  console.log(
    `${activeNetworks.length} active networks identified: ${activeNetworks.map(
      (network) => network.id
    )}\n`
  )

  // remove testnets
  const mainnets = activeNetworks.filter(
    (network) => !isTestnetNetwork(network.id)
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
  if (gasZipUnsupportedNetworks.length)
    console.warn(
      `The following ${
        gasZipUnsupportedNetworks.length
      } networks are not supported by GasZip and need to be funded manually: ${JSON.stringify(
        gasZipUnsupportedNetworks.map((chain) => chain.id),
        null,
        2
      )}\n`
    )

  console.log(
    `${gasZipSupportedNetworks.length} of those networks are supported by GasZip\n`
  )

  // apply the doNotFundChains exclusion (by chainId)
  const excludedNetworks = gasZipSupportedNetworks.filter((network) =>
    excludedChainIds.has(network.chainId)
  )
  const filteredNetworks = gasZipSupportedNetworks.filter(
    (network) => !excludedChainIds.has(network.chainId)
  )

  if (excludedNetworks.length)
    console.warn(
      `Excluding ${
        excludedNetworks.length
      } networks (via doNotFundChains): ${JSON.stringify(
        excludedNetworks.map((chain) => ({
          id: chain.id,
          chainId: chain.chainId,
        })),
        null,
        2
      )}\n`
    )

  // warn if any excluded chainIds did not match any Gas.zip-supported network
  const matchedChainIds = new Set(excludedNetworks.map((n) => n.chainId))
  const unmatchedChainIds = [...excludedChainIds].filter(
    (id) => !matchedChainIds.has(id)
  )
  if (unmatchedChainIds.length)
    console.warn(
      `The following doNotFundChains entries did not match any Gas.zip-supported active mainnet and had no effect: ${JSON.stringify(
        unmatchedChainIds
      )}\n`
    )

  console.log(
    `${filteredNetworks.length} networks will be funded: ${JSON.stringify(
      filteredNetworks.map((chain) => chain.id)
    )}\n`
  )

  return filteredNetworks
}

runMain(main)
