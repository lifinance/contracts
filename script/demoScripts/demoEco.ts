import { randomBytes } from 'crypto'

import { defineCommand, runMain } from 'citty'
import { config } from 'dotenv'
import { parseUnits, zeroAddress, type Narrow } from 'viem'
import { erc20Abi } from 'viem'

import ecoFacetArtifact from '../../out/EcoFacet.sol/EcoFacet.json'
import type { ILiFi } from '../../typechain'
import type { SupportedChain } from '../common/types'

import {
  ADDRESS_USDC_OPT,
  ADDRESS_USDC_BASE,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// #region ABIs
const ECO_FACET_ABI = ecoFacetArtifact.abi as Narrow<
  typeof ecoFacetArtifact.abi
>
// #endregion

// Chain IDs mapping
const CHAIN_IDS: Record<string, number> = {
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
  ethereum: 1,
  polygon: 137,
}

// Token addresses per chain
const USDC_ADDRESSES: Record<string, string> = {
  optimism: ADDRESS_USDC_OPT,
  base: ADDRESS_USDC_BASE,
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ethereum: '0xA0b86991c59218FddE44e6996C8a21e9D5AA5F6dd5',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
}

// Eco API configuration
const ECO_API_URL = process.env.ECO_API_URL || 'https://quotes-preprod.eco.com'
const DAPP_ID = process.env.ECO_DAPP_ID || 'lifi-demo'

interface IEcoQuoteRequest {
  dAppID: string
  quoteRequest: {
    sourceChainID: number
    destinationChainID: number
    sourceToken: string
    destinationToken: string
    sourceAmount: string
    funder: string
    refundRecipient: string
    recipient: string
  }
  contracts?: {
    sourcePortal?: string
    destinationPortal?: string
    prover?: string
  }
}

interface IEcoQuoteResponse {
  data: {
    quoteResponse: {
      sourceChainID: number
      destinationChainID: number
      sourceToken: string
      destinationToken: string
      sourceAmount: string
      destinationAmount: string
      funder: string
      refundRecipient: string
      recipient: string
      fees: Array<{
        name: string
        description: string
        token: {
          address: string
          decimals: number
          symbol: string
        }
        amount: string
      }>
      deadline: number
      estimatedFulfillTimeSec: number
    }
    contracts: {
      sourcePortal: string
      destinationPortal: string
      prover: string
    }
  }
}

async function getEcoQuote(
  sourceChain: string,
  destinationChain: string,
  amount: bigint,
  signerAddress: string
): Promise<IEcoQuoteResponse> {
  const sourceChainId = CHAIN_IDS[sourceChain]
  const destinationChainId = CHAIN_IDS[destinationChain]
  const sourceToken = USDC_ADDRESSES[sourceChain]
  const destinationToken = USDC_ADDRESSES[destinationChain]

  if (!sourceChainId || !destinationChainId)
    throw new Error(`Unsupported chain: ${sourceChain} or ${destinationChain}`)

  if (!sourceToken || !destinationToken)
    throw new Error(
      `USDC address not found for chain: ${sourceChain} or ${destinationChain}`
    )

  const quoteRequest: IEcoQuoteRequest = {
    dAppID: DAPP_ID,
    quoteRequest: {
      sourceChainID: sourceChainId,
      destinationChainID: destinationChainId,
      sourceToken,
      destinationToken,
      sourceAmount: amount.toString(),
      funder: signerAddress,
      refundRecipient: signerAddress,
      recipient: signerAddress,
    },
  }

  console.log('Fetching quote from Eco API...')
  console.log('Quote request:', JSON.stringify(quoteRequest, null, 2))

  const response = await fetch(`${ECO_API_URL}/api/v3/quotes/getQuote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(quoteRequest),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to get quote: ${response.status} - ${errorText}`)
  }

  const data = (await response.json()) as IEcoQuoteResponse
  console.log('Quote received:', JSON.stringify(data, null, 2))

  return data
}

async function main(args: {
  srcChain: SupportedChain
  dstChain: string
  amount: string
}) {
  // === Set up environment ===
  const srcChain = args.srcChain

  const { publicClient, walletAccount, walletClient, lifiDiamondContract } =
    await setupEnvironment(srcChain, ECO_FACET_ABI)
  const signerAddress = walletAccount.address

  if (!lifiDiamondContract || !lifiDiamondContract.address)
    throw new Error('LiFi Diamond contract not found')

  console.info(
    `Bridge ${args.amount} USDC from ${srcChain} --> ${args.dstChain}`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  // === Get quote from Eco API ===
  const amount = parseUnits(args.amount, 6) // USDC has 6 decimals
  const quote = await getEcoQuote(
    srcChain,
    args.dstChain,
    amount,
    signerAddress
  )

  // Extract fee amount from quote
  const protocolFee = quote.data.quoteResponse.fees.find(
    (f) => f.name === 'Eco Protocol Fee'
  )
  if (!protocolFee) throw new Error('No protocol fee found in quote')

  const feeAmount = BigInt(protocolFee.amount)

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = USDC_ADDRESSES[srcChain] as `0x${string}`

  // Ensure wallet has sufficient USDC balance (amount + fee)
  const totalAmount = amount + feeAmount

  const usdcContract = {
    read: {
      balanceOf: async (args: [`0x${string}`]): Promise<bigint> => {
        return (await publicClient.readContract({
          address: SRC_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args,
        })) as bigint
      },
    },
  } as const

  await ensureBalance(usdcContract, signerAddress, totalAmount, publicClient)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'eco',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress, // Receiver on destination chain (same as signer)
    destinationChainId: BigInt(quote.data.quoteResponse.destinationChainID),
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // === Prepare EcoData ===
  const ecoData = {
    receiverAddress: signerAddress, // Receiver on destination chain (same as signer)
    nonEVMReceiver: '0x', // Empty for EVM chains
    receivingAssetId: quote.data.quoteResponse.destinationToken, // USDC token on destination chain
    salt: `0x${randomBytes(32).toString('hex')}`, // Unique identifier
    destinationInbox: quote.data.contracts.destinationPortal, // Inbox address on destination chain from quote
    prover: quote.data.contracts.prover, // Prover address from quote
    rewardDeadline: BigInt(quote.data.quoteResponse.deadline), // Deadline from quote
    solverReward: feeAmount, // Solver fee from quote
    destinationCalls: [], // No destination calls for this demo
  }

  // === Ensure allowance ===
  const tokenContract = {
    read: {
      allowance: async (
        args: [`0x${string}`, `0x${string}`]
      ): Promise<bigint> => {
        return (await publicClient.readContract({
          address: SRC_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'allowance',
          args,
        })) as bigint
      },
    },
    write: {
      approve: async (
        args: [`0x${string}`, bigint]
      ): Promise<`0x${string}`> => {
        return walletClient.writeContract({
          address: SRC_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args,
        } as any)
      },
    },
  }

  await ensureAllowance(
    tokenContract,
    signerAddress as `0x${string}`,
    lifiDiamondContract.address,
    amount + feeAmount, // Approve minAmount + fee
    publicClient
  )

  // === Start bridging ===
  console.log('Transaction details:')
  console.log('  Source amount:', amount.toString())
  console.log(
    '  Destination amount:',
    quote.data.quoteResponse.destinationAmount
  )
  console.log('  Protocol fee:', ecoData.solverReward.toString())
  console.log(
    '  Estimated fulfillment time:',
    quote.data.quoteResponse.estimatedFulfillTimeSec,
    'seconds'
  )
  console.log('  Bridge data:', bridgeData)
  console.log('  Eco data:', ecoData)

  await executeTransaction(
    () =>
      walletClient.writeContract({
        address: lifiDiamondContract.address,
        abi: ECO_FACET_ABI,
        functionName: 'startBridgeTokensViaEco',
        args: [bridgeData, ecoData],
        // No value needed - fee is paid in USDC
      }),
    'Starting bridge tokens via Eco',
    publicClient,
    true
  )
}

const command = defineCommand({
  meta: {
    name: 'demoEco',
    description: 'Demo script for bridging tokens via Eco Protocol',
  },
  args: {
    srcChain: {
      type: 'string',
      default: 'optimism',
      description: 'Source chain for the bridge (e.g., optimism)',
    },
    dstChain: {
      type: 'string',
      default: 'base',
      description: 'Destination chain for the bridge (e.g., base)',
    },
    amount: {
      type: 'string',
      default: '5',
      description: 'Amount of USDC to bridge',
    },
  },
  async run({ args }) {
    await main({
      srcChain: args.srcChain as SupportedChain,
      dstChain: args.dstChain,
      amount: args.amount,
    })
  },
})

runMain(command)
