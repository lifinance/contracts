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

// Portal address is the same on every chain
const ECO_PORTAL_ADDRESS = '0x90F0c8aCC1E083Bcb4F487f84FC349ae8d5e28D7'
const ECO_PROVER_ADDRESS = '0xC09483299100ab9960eA1F641b0f94B9E6e0923C'

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

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = ADDRESS_USDC_OPT as `0x${string}`
  const amount = parseUnits(args.amount, 6) // USDC has 6 decimals

  // Ensure wallet has sufficient USDC balance
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

  await ensureBalance(usdcContract, signerAddress, amount, publicClient)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'eco',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress, // Receiver on destination chain (same as signer)
    destinationChainId: args.dstChain === 'base' ? 8453 : 8453, // Default to Base for now
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // === Prepare EcoData ===
  const ecoData = {
    receiverAddress: signerAddress, // Receiver on destination chain (same as signer)
    nonEVMReceiver: '0x', // Empty for EVM chains
    receivingAssetId: SRC_TOKEN_ADDRESS, // Same USDC token on Base
    salt: `0x${randomBytes(32).toString('hex')}`, // Unique identifier
    routeDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
    destinationPortal: ECO_PORTAL_ADDRESS,
    prover: ECO_PROVER_ADDRESS,
    rewardDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200), // 2 hours from now
    solverReward: parseUnits('0.0001', 18), // 0.0001 ETH reward
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
    amount,
    publicClient
  )

  // === Start bridging ===
  console.log('Transaction details:')
  console.log('  Value to send:', ecoData.solverReward.toString())
  console.log('  Bridge data:', bridgeData)
  console.log('  Eco data:', ecoData)

  await executeTransaction(
    () =>
      walletClient.writeContract({
        address: lifiDiamondContract.address,
        abi: ECO_FACET_ABI,
        functionName: 'startBridgeTokensViaEco',
        args: [bridgeData, ecoData],
        value: ecoData.solverReward, // Must send solver reward as msg.value
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
