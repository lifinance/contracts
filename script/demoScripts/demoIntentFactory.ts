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

const INTENT_FACTORY_ADDReSS = Deployments.IntentFactory as Address
const ABI = IntentFactory.abi

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
    // Read client
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(),
    })

    // Write client
    const walletClient = createWalletClient({
      account: privateKeyToAccount(args.privateKey as Hex),
      chain: arbitrum,
      transport: http(),
    })

    const intentFactory = {
      address: INTENT_FACTORY_ADDReSS,
      abi: ABI,
    }

    const predictedIntentAddress = await publicClient.readContract({
      ...intentFactory,
      functionName: 'getIntentAddress',
      args: [
        {
          intentId: keccak256(toHex(parseInt(Math.random().toString()))),
          receiver: privateKeyToAccount(args.privateKey as Hex).address,
          tokenOut: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
          amountOutMin: parseUnits('10', 6),
        },
      ],
    })
    console.log(predictedIntentAddress)
  },
})

runMain(main)
