import { randomBytes } from 'crypto'

import { config as dotenvConfig } from 'dotenv'
import { parseEther, parseUnits, zeroAddress, type Narrow } from 'viem'

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

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 10

  const { publicClient, walletClient, walletAccount, lifiDiamondAddress } =
    await setupEnvironment(srcChain, GLACIS_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS =
    '0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91' as `0x${string}`
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

  await ensureBalance(
    { address: SRC_TOKEN_ADDRESS, abi: ERC20_ABI },
    signerAddress,
    amount
  )

  await ensureAllowance(
    { address: SRC_TOKEN_ADDRESS, abi: ERC20_ABI },
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
