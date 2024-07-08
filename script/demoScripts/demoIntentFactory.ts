import { arbitrum } from 'viem/chains'
import { defineCommand, runMain } from 'citty'
import * as Deployments from '../../deployments/arbitrum.staging.json'
import * as IntentFactory from '../../out/IntentFactory.sol/IntentFactory.json'
import {
  Address,
  Hex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseUnits,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ChainId, getQuote } from '@lifi/sdk'

const INTENT_FACTORY_ADDReSS = Deployments.IntentFactory as Address
const ABI = IntentFactory.abi
const DAI = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

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

    const intentFactory = {
      address: INTENT_FACTORY_ADDReSS,
      abi: ABI,
    }

    const predictedIntentAddress: Address = (await publicClient.readContract({
      ...intentFactory,
      functionName: 'getIntentAddress',
      args: [
        {
          intentId: keccak256(toHex(parseInt(Math.random().toString()))),
          receiver: account.address,
          tokenOut: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
          amountOutMin: parseUnits('10', 6),
        },
      ],
    })) as Address
    console.log(predictedIntentAddress)

    const quote = await getQuote({
      fromAddress: predictedIntentAddress,
      toAddress: account.address,
      fromChain: ChainId.ARB,
      toChain: ChainId.ARB,
      fromToken: DAI,
      toToken: USDC,
      fromAmount: '10000000000000000000',
    })

    console.log(quote)
    // TODO: Send DAI to predictedIntentAddress
    // TODO: Execute the swap
  },
})

runMain(main)
