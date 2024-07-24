import { defineCommand, runMain } from 'citty'
import {
  Abi,
  Hex,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getContract,
  http,
  parseAbi,
  zeroAddress,
  type Chain,
} from 'viem'
import { ethers } from 'ethers6'
import * as chains from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { getAllNetworks, node_url } from '../../utils/network'
import axios from 'axios'
import { multicall } from 'viem/actions'

/// TYPES ///

type Token = {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  priceUSD: string
  coinKey: string
  logoURI: string
}

interface TokensByChainId {
  [chainId: string]: Token[]
}

interface TokenAPIResponse {
  tokens: TokensByChainId
}

type TokenBalance = {
  token: Token
  balance: string
}

type Contract = {
  address: `0x${string}`
  abi: Abi
}

type MultiCall = Contract & {
  functionName: string
  args?: any[]
  client?: any
}

export const chainNameMappings: Record<string, string> = {
  zksync: 'zkSync',
  polygonzkevm: 'polygonZkEvm',
}

// will contain a list of all tokens
const BASE_URL_LIFI_API = `https://partner-test.li.quest/v1`
const fullURL = `${BASE_URL_LIFI_API}/tokens`
let allTokens: TokenAPIResponse

const getAllKnownERC20Tokens = async () => {
  // not yet initialized
  if (!allTokens) {
    try {
      // get a list of all tokens
      const result = await axios(fullURL)

      // return only the "tokens" property
      allTokens = result.data
    } catch (err) {
      const msg = JSON.stringify(err, null, 2)
      throw new Error(msg)
    }
  }

  if (!allTokens) throw Error(`could not get a list of all ERC20 tokens`)

  return allTokens
}

const getAllKnownERC20TokensForChain = async (chainId: number) => {
  const allTokens = await getAllKnownERC20Tokens()

  if (!allTokens.tokens)
    throw Error('Error while getting all known ERC20 tokens')

  // return only the tokens for the given chainId, or throw an error if none exist
  if (allTokens.tokens[chainId.toString()]) {
    return allTokens.tokens[chainId.toString()]
  } else {
    throw new Error(`No tokens found for chainId: ${chainId}`)
  }
}

const doNotExecuteOnNetworks = [
  'localanvil',
  'sepolia',
  'mumbai',
  'lineatest',
  'bsc-testnet',
  'virtualtestnet',
]

const getAllSupportedNetworks = () => {
  // get a list of all networks
  const networks = getAllNetworks()

  // filter out all testnets and local networks
  return networks.filter((network) => !doNotExecuteOnNetworks.includes(network))
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

const main = defineCommand({
  meta: {
    name: 'move-all-funds-to-new-wallet',
    description:
      'Moves all ERC20 and native funds of a wallet to another address on all supported chains',
  },
  args: {
    privateKey: {
      type: 'string',
      description: 'Private key of the source wallet',
      required: true,
    },
    newWallet: {
      type: 'string',
      description: 'Address of the receiving wallet',
      required: true,
    },
  },
  async run({ args }) {
    const { privateKey, newWallet } = args
    const srcWallet = privateKeyToAccount(`0x${privateKey}` as `0x${string}`)

    // const networks = await getAllSupportedNetworks()
    const networks = ['mainnet']
    console.log(`${networks.length} networks found`)

    // const chainTokens = await getAllKnownERC20TokensForChain(1)
    // console.log(`${chainTokens.length} tokens found`)

    // iterate through the list of networks
    const promises = await Promise.allSettled(
      networks.map((network) =>
        performTaskOnNetwork(network, srcWallet.address)
      )
    )

    // create an overview to show results per network
    const overview = promises.map((result, index) => {
      const network = networks[index]
      return {
        network,
        status: result.status,
        reason: result.status === 'rejected' ? result.reason : undefined,
      }
    })

    // console.log('Task Overview:')
    // overview.forEach((result) => {
    //   if (result.status === 'fulfilled') {
    //     console.log(`Network: ${result.network}: Success`)
    //   } else {
    //     console.log(
    //       `Network: ${result.network}: Not executed - ${result.reason}`
    //     )
    //   }
    // })
  },
})

// Function to perform some asynchronous task on a network
const performTaskOnNetwork = async (
  network: string,
  srcWallet: `0x${string}`
): Promise<void> => {
  // get the (viem) chain for this network
  const chainName = chainNameMappings[network] || network
  const chain: Chain = chainMap[chainName]

  // get RPC URL
  const rpcUrl = node_url(network)

  // get viem public client to read from blockchain
  const publicClient = createPublicClient({
    // batch: { multicall: true },
    // chain: chain,
    chain: chains.mainnet,
    transport: http(),
    // transport: http(rpcUrl),
  })

  // check get native balance
  // const nativeBalance = await publicClient.getBalance({
  //   address: srcWallet,
  // })
  // console.log(`native Balance (${network}): ${nativeBalance} `)

  // get balances of source wallet
  const balances = await getAllERC20BalancesForWallet(
    srcWallet,
    chain.id,
    publicClient
  )
  // console.log(`${balances.length} balances found`)

  // iterate through all balances

  // send tokens to new wallet
}

const getAllERC20BalancesForWallet = async (
  wallet: `0x${string}`,
  chainId: number,
  publicClient: any
): Promise<TokenBalance[]> => {
  // get all tokens
  const chainTokens = await getAllKnownERC20TokensForChain(chainId)
  // console.log(`${chainTokens.length} tokens found`)

  const calls: MultiCall[] = []

  // prepare a balanceOf call for each token address
  chainTokens.forEach((token) => {
    // console.log(`tokenAddress: ${token.address} `)
    // get contract reader with token address
    // const tokenReader = getContract({
    //   address: token.address as `0x${string}`,
    //   abi: parseAbi([
    //     'function balanceOf(address) external view returns (uint256)',
    //   ]),
    //   // abi: erc20Abi,
    // })
    // console.log(`tokenReader.address: ${tokenReader.address}`)
    // console.log(`tokenReader.abi: ${tokenReader.abi.length}`)

    // filter out native tokens
    if (token.address !== zeroAddress) {
      // create multicall object for current tokenAddress
      const newCall = {
        // ...tokenReader,
        address: token.address as `0x${string}`,
        abi: erc20Abi,
        // abi: parseAbi([
        //   'function balanceOf(address) external view returns (uint256)',
        // ]),
        functionName: 'balanceOf',
        args: [wallet],
      }

      // console.log(`newCall.address: ${newCall.address}`)
      // console.log(`newCall.abi.length: ${newCall.abi.length}`)
      // console.log(`newCall.abi: ${JSON.stringify(newCall.abi, null, 2)}`)

      // add call
      calls.push(newCall)
    }
  })

  console.log(`${calls.length ?? 0} multicalls created`)

  // execute multicalls
  console.log(`calls[0]: ${JSON.stringify(calls[0], null, 2)}`)
  console.log(`calls[1]: ${JSON.stringify(calls[1], null, 2)}`)
  console.log(`calls[2]: ${JSON.stringify(calls[2], null, 2)}`)
  console.log('')
  console.log(`publicClient: ${JSON.stringify(publicClient, null, 2)}`)
  console.log('')

  console.log(`Before execution on chain ${chainId}`)
  let results
  try {
    console.log('in try')
    const twoCalls = []
    twoCalls.push(calls[0])
    twoCalls.push(calls[1])
    results = await publicClient.multicall({
      // contracts: calls,
      contracts: twoCalls,
      // ...publicClient.contracts,
      multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
      // batchSize: 200,
    })
    // results = await multicall(publicClient, {
    //   // contracts: calls,
    //   contracts: [{ ...publicClient.contracts, oneCall }],
    //   // batchSize: 200,
    // })
  } catch (err) {
    console.log(`Error: ${JSON.stringify(err, null, 2)}`)
  }

  if (!results) throw Error('no results')

  console.log(`results (${chainId}): ${JSON.stringify(results, null, 2)}`)
  console.log(`results[0] : ${results[0].result}`)

  console.log('HERE')

  // return balances

  // get a list of all tokens we know on this chain
  // const allKnownTokensOnChain = async (chain: number): Promise<Token[]> => {
  //   const allTokens = await allKnownTokensOnChain(chainId)

  //   console.log(`${allTokens.length} tokens found`)
  //   // console.log(`allKnownTokensOnChain: ${JSON.stringify(allTokens, null, 2)}`)
  //   console.log(``)
  //   console.log(``)

  //   return []

  //   // // prepare a multicall to get the balance of all tokens
  //   // const getTokenBalances =
  //   //   async (
  //   //     allTokens: Token[],
  //   //     ofWallet: string
  //   //   ): Promise<TokenWithBalance[]> => {
  //   //     const allAddresses = allTokens.map((token) => token.address)
  //   //     const tokenLookup: Record<string, Token> = toMap<Token>(
  //   //       allTokens,
  //   //       (t: Token) => t.address
  //   //     )

  //   //     return multicallGetBalance(allAddresses, config.chain, ofWallet).then(
  //   //       (results) =>
  //   //         results.flatMap((result, i) =>
  //   //           isSuccessful(result) && tokenLookup[allAddresses[i]].priceUSD
  //   //             ? [
  //   //                 {
  //   //                   ...tokenLookup[allAddresses[i]],
  //   //                   balance: new BigNumber(BN.from(result.data[0]).toString()),
  //   //                   balanceUSD: new BigNumber(
  //   //                     BN.from(result.data[0]).toString()
  //   //                   )
  //   //                     .shiftedBy(-tokenLookup[allAddresses[i]].decimals)
  //   //                     .multipliedBy(tokenLookup[allAddresses[i]].priceUSD)
  //   //                     .decimalPlaces(2)
  //   //                     .toString(),
  //   //                 },
  //   //               ]
  //   //             : []
  //   //         )
  //   //     )
  //   //   }
  // }

  return []
}

runMain(main)
