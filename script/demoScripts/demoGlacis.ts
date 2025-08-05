import { randomBytes } from 'crypto'

import { config as dotenvConfig } from 'dotenv'
import {
  encodeFunctionData,
  getAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Narrow,
} from 'viem'

import glacisConfig from '../../config/glacis.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import glacisFacetArtifact from '../../out/GlacisFacet.sol/GlacisFacet.json'
import airliftArtifact from '../../out/IGlacisAirlift.sol/IGlacisAirlift.json'
import type { GlacisFacet, ILiFi } from '../../typechain'
import type { SupportedChain } from '../common/types'

import {
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getConfigElement,
  setupEnvironment,
  zeroPadAddressToBytes32,
} from './utils/demoScriptHelpers'

dotenvConfig()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const GLACIS_FACET_ABI = glacisFacetArtifact.abi as Narrow<
  typeof glacisFacetArtifact.abi
>
const AIRLIFT_ABI = airliftArtifact.abi as Narrow<typeof airliftArtifact.abi>

// #endregion

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT ---------------------------------------------------------------------------------------------------
// ARB.W > OPT.W: https://arbiscan.io/tx/0xb1a1aaf006c0d9fde5da4006dc3d8b86c795cba1eb0bc4757181869503698230

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 10

  const { publicClient, walletClient, walletAccount, lifiDiamondAddress } =
    await setupEnvironment(srcChain, GLACIS_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = getAddress(
    '0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91'
  )
  const AIRLIFT_ADDRESS = getConfigElement(glacisConfig, srcChain, 'airlift')

  // === Read token metadata ===
  const srcTokenName = await publicClient.readContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'name',
  })

  const srcTokenSymbol = await publicClient.readContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'symbol',
  })

  const srcTokenDecimals = await publicClient.readContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'decimals',
  })

  const amount = parseUnits('1', Number(srcTokenDecimals))

  console.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> Optimism`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  if (!signerAddress) throw new Error('Signer address is required')
  if (!lifiDiamondAddress) throw new Error('LiFi Diamond address is required')

  // Create contract objects that work with the existing helper functions
  const srcTokenContract = {
    read: {
      balanceOf: async (args: [string]) =>
        publicClient.readContract({
          address: SRC_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args,
        }),
      allowance: async (args: [string, string]) =>
        publicClient.readContract({
          address: SRC_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args,
        }),
    },
    write: {
      approve: async (args: [string, bigint]) =>
        walletClient.writeContract({
          address: SRC_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args,
        }),
    },
  }

  await ensureBalance(srcTokenContract, signerAddress, amount, publicClient)

  await ensureAllowance(
    srcTokenContract,
    signerAddress,
    lifiDiamondAddress,
    amount,
    publicClient
  )

  let estimatedFees
  try {
    estimatedFees = (
      await publicClient.simulateContract({
        address: AIRLIFT_ADDRESS,
        abi: AIRLIFT_ABI,
        functionName: 'quoteSend',
        args: [
          SRC_TOKEN_ADDRESS,
          amount,
          zeroPadAddressToBytes32(signerAddress),
          BigInt(destinationChainId),
          signerAddress,
          parseEther('1'),
        ],
      })
    ).result as any

    if (!estimatedFees)
      throw new Error('Invalid fee estimation from quoteSend.')
  } catch (error) {
    console.error('Fee estimation failed:', error)
    process.exit(1)
  }

  const structuredFees = {
    gmpFee: {
      nativeFee: estimatedFees.gmpFee.nativeFee as bigint,
      tokenFee: estimatedFees.gmpFee.tokenFee as bigint,
    },
    airliftFee: {
      nativeFee: estimatedFees.airliftFeeInfo.airliftFee.nativeFee as bigint,
      tokenFee: estimatedFees.airliftFeeInfo.airliftFee.tokenFee as bigint,
    },
  }
  const nativeFee =
    structuredFees.gmpFee.nativeFee + structuredFees.airliftFee.nativeFee

  console.info(`Estimated native fee: ${nativeFee}`)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'glacis',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const glacisData: GlacisFacet.GlacisDataStruct = {
    receiverAddress: zeroPadAddressToBytes32(signerAddress),
    refundAddress: signerAddress,
    nativeFee,
  }

  // === Debug: Print all parameters ===
  console.info('\n=== DEBUG: All Parameters ===')
  console.info('LiFi Diamond Address:', lifiDiamondAddress)
  console.info('Airlift Address:', AIRLIFT_ADDRESS)
  console.info('Source Token Address:', SRC_TOKEN_ADDRESS)
  console.info('Source Token Name:', srcTokenName)
  console.info('Source Token Symbol:', srcTokenSymbol)
  console.info('Source Token Decimals:', srcTokenDecimals)
  console.info('Amount:', amount.toString())
  console.info(
    'Amount (formatted):',
    `${amount / BigInt(10 ** Number(srcTokenDecimals))} ${srcTokenSymbol}`
  )
  console.info('Destination Chain ID:', destinationChainId)
  console.info('Signer Address:', signerAddress)
  console.info('Native Fee:', nativeFee.toString())
  console.info('Native Fee (ETH):', `${Number(nativeFee) / 1e18} ETH`)

  console.info('\n=== Bridge Data ===')
  console.info('Transaction ID:', bridgeData.transactionId)
  console.info('Bridge:', bridgeData.bridge)
  console.info('Integrator:', bridgeData.integrator)
  console.info('Referrer:', bridgeData.referrer)
  console.info('Sending Asset ID:', bridgeData.sendingAssetId)
  console.info('Receiver:', bridgeData.receiver)
  console.info('Destination Chain ID:', bridgeData.destinationChainId)
  console.info('Min Amount:', bridgeData.minAmount.toString())
  console.info('Has Source Swaps:', bridgeData.hasSourceSwaps)
  console.info('Has Destination Call:', bridgeData.hasDestinationCall)

  console.info('\n=== Glacis Data ===')
  console.info('Receiver Address:', glacisData.receiverAddress)
  console.info('Refund Address:', glacisData.refundAddress)
  console.info('Native Fee:', glacisData.nativeFee.toString())

  console.info('\n=== Fee Breakdown ===')
  console.info('GMP Fee (native):', structuredFees.gmpFee.nativeFee.toString())
  console.info(
    'Airlift Fee (native):',
    structuredFees.airliftFee.nativeFee.toString()
  )
  console.info('Total Native Fee:', nativeFee.toString())

  console.info('\n=== Contract Call Parameters ===')
  console.info('Function: startBridgeTokensViaGlacis')
  console.info('Contract Address:', lifiDiamondAddress)
  console.info('Value (ETH):', `${Number(nativeFee) / 1e18} ETH`)

  // === Generate and print calldata ===
  const calldata = encodeFunctionData({
    abi: GLACIS_FACET_ABI,
    functionName: 'startBridgeTokensViaGlacis',
    args: [bridgeData, glacisData],
  })

  console.info('\n=== Calldata ===')
  console.info(
    'Function Signature: startBridgeTokensViaGlacis((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,address,uint256))'
  )
  console.info('Calldata:', calldata)
  console.info('Calldata Length:', calldata.length, 'characters')

  console.info('\n=== Executing Transaction ===')

  // === Start bridging ===
  if (!lifiDiamondAddress) throw new Error('LiFi Diamond address is required')
  await executeTransaction(
    () =>
      walletClient.writeContract({
        address: lifiDiamondAddress,
        abi: GLACIS_FACET_ABI,
        functionName: 'startBridgeTokensViaGlacis',
        args: [bridgeData, glacisData],
        value: nativeFee,
      }),
    'Starting bridge tokens via Glacis',
    publicClient,
    true
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
