import { randomBytes } from 'crypto'

import { consola } from 'consola'
import { config as dotenvConfig } from 'dotenv'
import {
  encodeFunctionData,
  getAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
} from 'viem'

import glacisConfig from '../../config/glacis.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import glacisFacetArtifact from '../../out/GlacisFacet.sol/GlacisFacet.json'
import airliftArtifact from '../../out/IGlacisAirlift.sol/IGlacisAirlift.json'
import type { GlacisFacet, ILiFi } from '../../typechain'
import type { SupportedChain } from '../common/types'

import {
  createContractObject,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getConfigElement,
  setupEnvironment,
  zeroPadAddressToBytes32,
} from './utils/demoScriptHelpers'

dotenvConfig()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Abi
const GLACIS_FACET_ABI = glacisFacetArtifact.abi as Abi
const AIRLIFT_ABI = airliftArtifact.abi as Abi

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

  consola.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> Optimism`
  )
  consola.info(`Connected wallet address: ${signerAddress}`)

  if (!signerAddress) throw new Error('Signer address is required')
  if (!lifiDiamondAddress) throw new Error('LiFi Diamond address is required')

  // Create contract objects that work with the existing helper functions
  const srcTokenContract = createContractObject(
    SRC_TOKEN_ADDRESS,
    ERC20_ABI,
    publicClient,
    walletClient
  )

  await ensureBalance(srcTokenContract, signerAddress, amount, publicClient)

  await ensureAllowance(
    srcTokenContract,
    signerAddress,
    lifiDiamondAddress,
    amount,
    publicClient
  )

  // Define the expected fee structure interface
  interface IEstimatedFeesResponse {
    gmpFee: {
      nativeFee: bigint
      tokenFee: bigint
    }
    airliftFeeInfo: {
      airliftFee: {
        nativeFee: bigint
        tokenFee: bigint
      }
    }
  }

  let estimatedFees: IEstimatedFeesResponse
  try {
    const simulationResult = await publicClient.simulateContract({
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

    estimatedFees = simulationResult.result as IEstimatedFeesResponse

    if (!estimatedFees)
      throw new Error('Invalid fee estimation from quoteSend.')
  } catch (error) {
    consola.error('Fee estimation failed:', error)
    process.exit(1)
  }

  const structuredFees = {
    gmpFee: {
      nativeFee: estimatedFees.gmpFee.nativeFee,
      tokenFee: estimatedFees.gmpFee.tokenFee,
    },
    airliftFee: {
      nativeFee: estimatedFees.airliftFeeInfo.airliftFee.nativeFee,
      tokenFee: estimatedFees.airliftFeeInfo.airliftFee.tokenFee,
    },
  }
  const nativeFee =
    structuredFees.gmpFee.nativeFee + structuredFees.airliftFee.nativeFee

  consola.info(`Estimated native fee: ${nativeFee}`)

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
  consola.info('\n=== DEBUG: All Parameters ===')
  consola.info('LiFi Diamond Address:', lifiDiamondAddress)
  consola.info('Airlift Address:', AIRLIFT_ADDRESS)
  consola.info('Source Token Address:', SRC_TOKEN_ADDRESS)
  consola.info('Source Token Name:', srcTokenName)
  consola.info('Source Token Symbol:', srcTokenSymbol)
  consola.info('Source Token Decimals:', srcTokenDecimals)
  consola.info('Amount:', amount.toString())
  consola.info(
    'Amount (formatted):',
    `${amount / BigInt(10 ** Number(srcTokenDecimals))} ${srcTokenSymbol}`
  )
  consola.info('Destination Chain ID:', destinationChainId)
  consola.info('Signer Address:', signerAddress)
  consola.info('Native Fee:', nativeFee.toString())
  consola.info('Native Fee (ETH):', `${Number(nativeFee) / 1e18} ETH`)

  consola.info('\n=== Bridge Data ===')
  consola.info('Transaction ID:', bridgeData.transactionId)
  consola.info('Bridge:', bridgeData.bridge)
  consola.info('Integrator:', bridgeData.integrator)
  consola.info('Referrer:', bridgeData.referrer)
  consola.info('Sending Asset ID:', bridgeData.sendingAssetId)
  consola.info('Receiver:', bridgeData.receiver)
  consola.info('Destination Chain ID:', bridgeData.destinationChainId)
  consola.info('Min Amount:', bridgeData.minAmount.toString())
  consola.info('Has Source Swaps:', bridgeData.hasSourceSwaps)
  consola.info('Has Destination Call:', bridgeData.hasDestinationCall)

  consola.info('\n=== Glacis Data ===')
  consola.info('Receiver Address:', glacisData.receiverAddress)
  consola.info('Refund Address:', glacisData.refundAddress)
  consola.info('Native Fee:', glacisData.nativeFee.toString())

  consola.info('\n=== Fee Breakdown ===')
  consola.info('GMP Fee (native):', structuredFees.gmpFee.nativeFee.toString())
  consola.info(
    'Airlift Fee (native):',
    structuredFees.airliftFee.nativeFee.toString()
  )
  consola.info('Total Native Fee:', nativeFee.toString())

  consola.info('\n=== Contract Call Parameters ===')
  consola.info('Function: startBridgeTokensViaGlacis')
  consola.info('Contract Address:', lifiDiamondAddress)
  consola.info('Value (ETH):', `${Number(nativeFee) / 1e18} ETH`)

  // === Generate and print calldata ===
  const calldata = encodeFunctionData({
    abi: GLACIS_FACET_ABI,
    functionName: 'startBridgeTokensViaGlacis',
    args: [bridgeData, glacisData],
  })

  consola.info('\n=== Calldata ===')
  consola.info(
    'Function Signature: startBridgeTokensViaGlacis((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,address,uint256))'
  )
  consola.info('Calldata:', calldata)
  consola.info('Calldata Length:', calldata.length, 'characters')

  consola.info('\n=== Executing Transaction ===')

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
    consola.error(error)
    process.exit(1)
  })
