import { defineCommand, runMain } from 'citty'
import {
  Abi,
  Hex,
  PrivateKeyAccount,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getContract,
  http,
  multicall3Abi,
  parseAbi,
  zeroAddress,
  type Chain,
} from 'viem'
import * as chains from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { getAllNetworks, node_url } from '../../utils/network'
import axios from 'axios'
import { mainnet } from 'viem/chains'
import { erc20 } from '@uma/sdk/dist/types/clients'
import { call, readContract, simulateContract } from 'viem/actions'
import { BigNumber } from 'ethers'

const ADDRESS_USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ADDRESS_WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ADDRESS_MULTICALL3_ETH = '0xcA11bde05977b3631167028862bE2a173976CA11'
const BALANCE_OF_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
])

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

type BalanceNotFound = 'BalanceNotFound'

type TokenBalance = {
  token: Token
  balance: string | BalanceNotFound
}

type Contract = {
  address: `0x${string}`
  abi: Abi
}

enum CallType {
  'balanceOf',
  'transfer',
}

type HexString = `0x${string}`

type MultiCall3 = {
  target: HexString
  allowFailure: boolean
  callData: HexString
}
type MultiCallResponse = {
  success: string
  returnData: HexString
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
    const networks = ['mainnet', 'bsc']
    console.log(`${networks.length} networks found`)

    // const chainTokens = await getAllKnownERC20TokensForChain(1)
    // console.log(`${chainTokens.length} tokens found`)

    // iterate through the list of networks
    const promises = await Promise.allSettled(
      networks.map((network) =>
        performTaskOnNetwork(network, srcWallet, newWallet as HexString)
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

    console.log('Task Overview:')
    overview.forEach((result) => {
      if (result.status === 'fulfilled') {
        console.log(`Network: ${result.network}: Success`)
      } else {
        console.log(
          `Network: ${result.network}: Not executed - ${result.reason}`
        )
      }
    })
  },
})

const getCalldata = (type: CallType, args: any): string => {
  let callData
  try {
    callData = encodeFunctionData({
      abi: erc20Abi,
      functionName: type == CallType.balanceOf ? 'balanceOf' : 'transfer',
      args,
    })
  } catch (error: any) {
    console.error(`ERROR: ${error.message})`)
  }

  if (!callData) throw new Error('no calldata')

  return callData
}

const getMulticall = (
  contractAddress: HexString,
  type: CallType,
  args: any
): MultiCall3 => {
  const callData = getCalldata(type, args) as HexString

  const call: MultiCall3 = {
    target: contractAddress,
    allowFailure: true,
    callData,
  }
  return call
}

const transferBalances = async (
  publicClient: any,
  srcWallet: PrivateKeyAccount,
  balances: TokenBalance[],
  receiverAddress: HexString
) => {
  console.log(`in transferBalances`)

  // get transfer() multicalls for each balance
  const multicalls = balances.map((balance) =>
    getMulticall(balance.token.address as HexString, CallType.transfer, [
      receiverAddress,
      balance.balance,
    ])
  )

  console.log(`${multicalls.length} transfer calls prepared`)

  // send transaction
  // const { result } = await publicClient.writeContract({
  //   account: srcWallet.address,
  //   address: ADDRESS_MULTICALL3_ETH,
  //   abi: multicall3Abi,
  //   functionName: 'aggregate3',
  //   args: [multicalls],
  // })

  // check success
}

// Function to perform some asynchronous task on a network
const performTaskOnNetwork = async (
  network: string,
  srcWallet: PrivateKeyAccount,
  newWallet: HexString
): Promise<void> => {
  console.log(`in performTaskOnNetwork`)
  // get the (viem) chain for this network
  const chainName = chainNameMappings[network] || network
  const chain: Chain = chainMap[chainName]

  // get RPC URL
  const rpcUrl = node_url(network)

  // get viem public client to read from blockchain
  const publicClient = createPublicClient({
    // batch: { multicall: true },
    chain,
    transport: http(),
    // transport: http(rpcUrl),
  })

  // create wallet client for this chain
  const walletClient = createWalletClient({
    chain,
    transport: http(),
    account: srcWallet,
  })

  // const callData = getBalanceOfCalldata(
  //   publicClient,
  //   ADDRESS_USDC_ETH,
  //   srcWallet.address,
  //   walletClient
  // )
  // console.log(`calldata: ${callData}`)

  // console.log(`Before data on chain ${chain}`)

  // const data = await publicClient.readContract({
  //   address: ADDRESS_USDC_ETH,
  //   // abi: BALANCE_OF_ABI,
  //   abi: erc20Abi,
  //   functionName: 'balanceOf',
  //   args: [srcWallet.address],
  // })

  // console.log(`after data ${data}`)
  // console.log(`data: ${JSON.stringify(data, null, 2)}`)

  // prepare multicall

  // check get native balance
  // const nativeBalance = await publicClient.getBalance({
  //   address: srcWallet,
  // })
  // console.log(`native Balance (${network}): ${nativeBalance} `)

  // get balances of source wallet
  const balances = await getAllERC20BalancesForWallet(
    srcWallet,
    chain.id,
    publicClient,
    walletClient
  )
  console.log(`${balances.length} balances found`)

  // iterate through all balances
  const transferResults = await transferBalances(
    publicClient,
    srcWallet,
    balances,
    newWallet as Hex
  )

  // check results
}

const convertBalanceFromMulticallResponse = (
  response: MultiCallResponse
): string => {
  // check if data is available
  if (!response || !response.success) {
    return 'BalanceNotFound'
  }

  // some contracts respond with empty string
  if (response.returnData === '0x') return '0'

  // convert hex to string
  return BigNumber.from(response.returnData).toString()
}

const getAllERC20BalancesForWallet = async (
  srcWallet: PrivateKeyAccount,
  chainId: number,
  publicClient: any,
  walletClient: any
): Promise<TokenBalance[]> => {
  // get all tokens
  const chainTokens = await getAllKnownERC20TokensForChain(chainId)

  const calls: MultiCall3[] = []

  // get a multicall object for each token address
  chainTokens.forEach((token) => {
    const multicall = getMulticall(
      token.address as HexString,
      CallType.balanceOf,
      [srcWallet.address]
    )
    if (calls.length < 500) calls.push(multicall)
  })

  console.log(`${calls.length} balanceOf calls prepared`)

  const { result } = await publicClient.simulateContract({
    account: srcWallet,
    address: ADDRESS_MULTICALL3_ETH,
    abi: multicall3Abi,
    functionName: 'aggregate3',
    args: [calls],
  })

  return (
    chainTokens
      .map((token, index) => {
        const tokenBalance: TokenBalance = {
          token,
          balance: convertBalanceFromMulticallResponse(result[index]),
        }

        return tokenBalance
      })
      // filter out zero and unavailable balances
      .filter(
        (tokenBalance) =>
          tokenBalance.balance !== '0' &&
          tokenBalance.balance !== 'BalanceNotFound'
      )
  )
}

runMain(main)
