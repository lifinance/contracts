import { randomBytes } from 'crypto'

import dotenv from 'dotenv'
import {
  getContract,
  parseUnits,
  zeroAddress,
  parseEther,
  type Narrow,
} from 'viem'

import config from '../../config/glacis.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import glacisFacetArtifact from '../../out/GlacisFacet.sol/GlacisFacet.json'
import airliftArtifact from '../../out/IGlacisAirlift.sol/IGlacisAirlift.json'
import type { GlacisFacet, ILiFi } from '../../typechain'
import type { SupportedChain } from '../types/common'

import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
  getConfigElement,
  zeroPadAddressToBytes32,
} from './utils/demoScriptHelpers'

dotenv.config()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const GLACIS_FACET_ABI = glacisFacetArtifact.abi as Narrow<
  typeof glacisFacetArtifact.abi
>
const AIRLIFT_ABI = airliftArtifact.abi as Narrow<typeof airliftArtifact.abi>

// #endregion

dotenv.config()

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 10

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, GLACIS_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS =
    '0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91' as `0x${string}`
  const AIRLIFT_ADDRESS = getConfigElement(config, srcChain, 'airlift')

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    client,
  })

  const airliftContract = getContract({
    address: AIRLIFT_ADDRESS,
    abi: AIRLIFT_ABI,
    client,
  })

  const srcTokenName = (await srcTokenContract.read.name()) as string
  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as bigint
  const amount = parseUnits('1', Number(srcTokenDecimals))

  console.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> Optimism`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

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
      await airliftContract.simulate.quoteSend([
        SRC_TOKEN_ADDRESS,
        amount,
        zeroPadAddressToBytes32(signerAddress),
        BigInt(destinationChainId),
        signerAddress,
        parseEther('1'),
      ])
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
    refundAddress: signerAddress,
    nativeFee,
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaGlacis(
        [bridgeData, glacisData],
        { value: nativeFee }
      ),
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
