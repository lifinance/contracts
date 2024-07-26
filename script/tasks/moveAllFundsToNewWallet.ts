import { defineCommand, runMain } from 'citty'
import {
  Abi,
  Hex,
  PrivateKeyAccount,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  multicall3Abi,
  parseAbi,
  type Chain,
} from 'viem'
import * as chains from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  chainNameMappings,
  getAllNetworks,
  getViemChainForNetworkName,
  node_url,
} from '../../utils/network'
import axios from 'axios'
import { mainnet } from 'viem/chains'
import { erc20 } from '@uma/sdk/dist/types/clients'
import { call, readContract, simulateContract, multicall } from 'viem/actions'
import { BigNumber } from 'ethers'
import BigNumberJs from 'bignumber.js'
import { getMulticall3AddressForChain } from '../../utils/getMulticallAddress'
import { Multicall2 } from '@arbitrum/sdk/dist/lib/abi/Multicall2'

const MAX_BATCH_SIZE_MULTICALLS = 500 // the max amount of multicalls we do in one call
const MIN_USD_THRESHOLD_BALANCE_TRANSFER = 5 // balances must be worth more than 5 USD, otherwise we leave them
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

// will contain a list of all tokens
const BASE_URL_LIFI_API = `https://partner-test.li.quest/v1`
const fullURL = `${BASE_URL_LIFI_API}/tokens`
let allTokens: TokenAPIResponse

const getAllTokens = async () => {
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
  const allTokens = await getAllTokens()

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

    let networks = await getAllSupportedNetworks()
    networks = ['mainnet', 'bsc']
    networks = ['mainnet']
    console.log(`${networks.length} networks found`)

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

const isAboveMinUSDThreshold = (balance: TokenBalance): boolean => {
  const usdAmount = new BigNumberJs(balance.balance)
    .multipliedBy(balance.token.priceUSD)
    .shiftedBy(-balance.token.decimals)

  return usdAmount.gte(MIN_USD_THRESHOLD_BALANCE_TRANSFER)
}

const transferBalances = async (
  publicClient: any,
  srcWallet: PrivateKeyAccount,
  balances: TokenBalance[],
  receiverAddress: HexString,
  multicall3Address: HexString
) => {
  // console.log(`[${publicClient.chain.name}] in transferBalances`)

  // get transfer() multicalls for each balance
  const multicalls = balances
    .map((balance) => {
      // check if balance is above min USD value, otherwise neglect this token
      if (isAboveMinUSDThreshold(balance)) {
        // create multicall for it
        return getMulticall(
          balance.token.address as HexString,
          CallType.transfer,
          [receiverAddress, balance.balance]
        )
      }
    })
    // filter out all empty multicalls
    .filter((call) => call != null)

  console.log(
    `[${publicClient.chain.name}] ${multicalls.length} transfer calls prepared`
  )

  // if exceedingly many potential transfers with min USD value are found, stop here and let the user check before proceeding
  if (multicalls.length > 30)
    throw new Error(
      `\n\n[${publicClient.chain.name}] more than ${
        multicalls.length
      } potential transfers found. Not continuing for protection of native funds.
      Please check if all transfers are legit and then run the script again. \n\n Multicalls: ${JSON.stringify(
        multicalls,
        null,
        2
      )}`
    )

  // send transaction
  // const { result } = await publicClient.writeContract({
  //   account: srcWallet.address,
  //   address: multicall3Address,
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
  // get the (viem) chain for this network
  const chain = getViemChainForNetworkName(network)
  console.log(`[${chain.name}] in performTaskOnNetwork`)

  // get RPC URL
  const rpcUrl = node_url(network)

  // get viem public client to read from blockchain
  const publicClient = createPublicClient({
    chain,
    transport: http(),
  })

  // create wallet client for this chain
  const walletClient = createWalletClient({
    chain,
    transport: http(),
    account: srcWallet,
  })

  // get multicall3 address for network
  const multicall3Address = (await getMulticall3AddressForChain(
    chain.id
  )) as HexString
  console.log(`[${chain.name}] multicall3 address found: ${multicall3Address}`)

  // check get native balance
  // const nativeBalance = await publicClient.getBalance({
  //   address: srcWallet,
  // })
  // console.log(`[${network}] native Balance (${network}): ${nativeBalance} `)

  // get balances of source wallet
  const balances = await getAllERC20BalancesForWallet(
    srcWallet,
    chain.id,
    publicClient,
    multicall3Address
  )
  console.log(
    `[${chain.name}] ${balances.length} balances above threshold ($ ${MIN_USD_THRESHOLD_BALANCE_TRANSFER}) found`
  )

  // transfer all balances
  const transferResults = await transferBalances(
    publicClient,
    srcWallet,
    balances,
    newWallet as Hex,
    multicall3Address
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

const batchExecuteMulticall = async (
  tokens: Token[],
  srcWallet: PrivateKeyAccount,
  publicClient: any,
  multicall3Address: HexString
) => {
  const calls: MultiCall3[] = []
  const results: MultiCallResponse[] = []

  // create a multicall call object for each token and execute one multicall for all
  const processBatch = async (batch: Token[]) => {
    batch.forEach((token) => {
      // get a multicall object for each token address
      const multicall = getMulticall(
        token.address as HexString,
        CallType.balanceOf,
        [srcWallet.address]
      )

      // add multicall object to calls array
      calls.push(multicall)
    })

    const { result } = await publicClient.simulateContract({
      account: srcWallet,
      address: multicall3Address,
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [calls],
    })

    console.log(`[${publicClient.chain.name}] result[0]: ${result[0]} `)
    console.log(
      `[${publicClient.chain.name}] ${result.length} results received from this batch`
    )

    return results.push(...result)
  }

  for (let i = 0; i < tokens.length; i += MAX_BATCH_SIZE_MULTICALLS) {
    // Get tokens for current batch
    const batchTokens = tokens.slice(i, i + MAX_BATCH_SIZE_MULTICALLS)

    console.log(
      `Processing chunk from index ${i} to ${i + MAX_BATCH_SIZE_MULTICALLS - 1}`
    )

    // create multicalls and execute them for this batch
    await processBatch(batchTokens)
  }

  console.log(`${calls.length} multicalls executed`)
  console.log(`${results.length} results received`)
  return results
}

const getAllERC20BalancesForWallet = async (
  srcWallet: PrivateKeyAccount,
  chainId: number,
  publicClient: any,
  multicall3Address: HexString
): Promise<TokenBalance[]> => {
  // get all tokens
  const chainTokens = await getAllKnownERC20TokensForChain(chainId)
  console.log(
    `[${publicClient.chain.name}] ${chainTokens.length} tokens found on this network`
  )

  const multicallResults = await batchExecuteMulticall(
    chainTokens,
    srcWallet,
    publicClient,
    multicall3Address
  )

  return (
    chainTokens
      .map((token, index) => {
        const tokenBalance: TokenBalance = {
          token,
          balance: convertBalanceFromMulticallResponse(multicallResults[index]),
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
