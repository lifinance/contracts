import { arbitrum } from 'viem/chains'
import { defineCommand, runMain } from 'citty'
import * as Deployments from '../../deployments/arbitrum.staging.json'
import * as IntentFactory from '../../out/IntentFactory.sol/IntentFactory.json'
import {
  Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ChainId, getQuote } from '@lifi/sdk'

const INTENT_FACTORY_ADDRESS = Deployments.IntentFactory as Address
const ABI = IntentFactory.abi
const ERC20_ABI = parseAbi([
  'function transfer(address,uint256) external',
  'function approve(address,uint256) external',
])
const DAI = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const AMOUNT_TO_SWAP = '1000000000000000000'

const main = defineCommand({
  meta: {
    name: 'propose-to-safe',
    description: 'Propose a transaction to a Gnosis Safe',
  },
  args: {
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
      required: true,
    },
  },
  async run({ args }) {
    const { privateKey } = args
    const account = privateKeyToAccount(`0x${privateKey}`)
    // Read client
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(),
    })

    // Write client
    const walletClient = createWalletClient({
      account,
      chain: arbitrum,
      transport: http(),
    })

    // Initialize the intentfactory
    const intentFactory = {
      address: INTENT_FACTORY_ADDRESS,
      abi: ABI,
    }

    // Get an initial quote from LIFI
    let quote = await getQuote({
      fromAddress: account.address,
      toAddress: account.address,
      fromChain: ChainId.ARB,
      toChain: ChainId.ARB,
      fromToken: DAI,
      toToken: USDC,
      fromAmount: AMOUNT_TO_SWAP,
    })
    console.log(quote)

    // Calculate the intent address
    const intentData = {
      intentId: keccak256(toHex(parseInt(Math.random().toString()))),
      receiver: account.address,
      tokenOut: USDC,
      amountOutMin: quote.estimate.toAmountMin,
    }
    const predictedIntentAddress: Address = (await publicClient.readContract({
      ...intentFactory,
      functionName: 'getIntentAddress',
      args: [intentData],
    })) as Address
    console.log(predictedIntentAddress)

    // Send DAI to predictedIntentAddress
    let tx = await walletClient.writeContract({
      address: DAI,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [predictedIntentAddress, BigInt(AMOUNT_TO_SWAP)],
    })
    console.log(tx)

    // Get updated quote and use intent address
    quote = await getQuote({
      fromAddress: predictedIntentAddress,
      toAddress: predictedIntentAddress,
      fromChain: ChainId.ARB,
      toChain: ChainId.ARB,
      fromToken: DAI,
      toToken: USDC,
      fromAmount: AMOUNT_TO_SWAP,
    })

    // Deploy intent and execute the swap
    const calls = []
    const approveCallData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [quote.estimate.approvalAddress as Address, BigInt(AMOUNT_TO_SWAP)],
    })
    calls.push({
      to: DAI,
      data: approveCallData,
      value: BigInt(0),
    })
    calls.push({
      to: quote.transactionRequest?.to,
      data: quote.transactionRequest?.data,
      value: BigInt(0),
    })
    tx = await walletClient.writeContract({
      address: intentFactory.address,
      abi: ABI,
      functionName: 'deployAndExecuteIntent',
      args: [intentData, calls],
    })
    console.log(tx)
  },
})

runMain(main)
