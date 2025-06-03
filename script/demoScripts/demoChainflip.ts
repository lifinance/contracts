// Import required libraries and artifacts
import { randomBytes } from 'crypto'

import dotenv from 'dotenv'
import {
  getContract,
  parseUnits,
  Narrow,
  zeroAddress,
  formatEther,
  formatUnits,
} from 'viem'

import deployments from '../../deployments/mainnet.staging.json'
import chainflipFacetArtifact from '../../out/ChainflipFacet.sol/ChainflipFacet.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import { ChainflipFacet, ILiFi } from '../../typechain'
import { SupportedChain } from '../types/common'

import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  ADDRESS_USDC_ARB,
  ADDRESS_USDT_ARB,
  ADDRESS_USDC_ETH,
  ADDRESS_UNISWAP_ETH,
  getUniswapDataERC20toExactERC20,
  getUniswapDataExactETHToERC20,
  ADDRESS_UNISWAP_ARB,
  setupEnvironment,
} from './utils/demoScriptHelpers'

dotenv.config()

// Contract addresses and ABIs
const RECEIVER_CHAINFLIP = deployments.ReceiverChainflip
const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const CHAINFLIP_FACET_ABI = chainflipFacetArtifact.abi as Narrow<
  typeof chainflipFacetArtifact.abi
>

/**
 * Executes a direct bridge transaction without any swaps
 * Transfers tokens directly from source to destination chain
 */
async function executeDirect(
  lifiDiamondContract: any,
  bridgeData: ILiFi.BridgeDataStruct,
  chainflipData: ChainflipFacet.ChainflipDataStruct,
  publicClient: any
) {
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaChainflip([
        bridgeData,
        chainflipData,
      ]),
    'Starting bridge tokens via Chainflip',
    publicClient,
    true
  )
}

/**
 * Executes a bridge transaction with a source chain swap
 * Swaps tokens on the source chain before bridging
 */
async function executeWithSourceSwap(
  lifiDiamondContract: any,
  bridgeData: ILiFi.BridgeDataStruct,
  chainflipData: ChainflipFacet.ChainflipDataStruct,
  amount: bigint,
  publicClient: any
) {
  const swapData = await getUniswapDataERC20toExactERC20(
    ADDRESS_UNISWAP_ARB,
    42161,
    ADDRESS_USDT_ARB,
    ADDRESS_USDC_ARB,
    amount,
    lifiDiamondAddress,
    true
  )

  await executeTransaction(
    () =>
      lifiDiamondContract.write.swapAndStartBridgeTokensViaChainflip([
        bridgeData,
        [swapData],
        chainflipData,
      ]),
    'Swapping and starting bridge tokens via Chainflip',
    publicClient,
    true
  )
}

/**
 * Executes a bridge transaction with a destination chain call
 * Bridges ETH and includes instructions for a swap on the destination chain
 */
async function executeWithDestinationCall(
  lifiDiamondContract: any,
  bridgeData: ILiFi.BridgeDataStruct,
  chainflipData: ChainflipFacet.ChainflipDataStruct,
  amount: bigint,
  publicClient: any
) {
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaChainflip(
        [bridgeData, chainflipData],
        { value: amount }
      ),
    'Starting bridge tokens via Chainflip with destination call',
    publicClient,
    true
  )
}

async function main() {
  const withSwap = process.argv.includes('--with-swap')
  const withDestinationCall = process.argv.includes('--with-destination-call')

  if (withSwap && withDestinationCall) {
    console.error(
      'Error: Cannot use both --with-swap and --with-destination-call flags'
    )
    process.exit(1)
  }

  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 1 // Mainnet

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, CHAINFLIP_FACET_ABI)
  const signerAddress = walletAccount.address

  // Amount setup
  const totalAmount = parseUnits('0.005', 18) // 0.005 ETH total
  const gasAmount = parseUnits('0.001', 18) // 0.001 ETH for gas
  const amount = withDestinationCall ? totalAmount : parseUnits('10', 6) // 10 USDC/USDT

  // Token setup
  const tokenToApprove = withDestinationCall
    ? zeroAddress
    : withSwap
    ? ADDRESS_USDT_ARB
    : ADDRESS_USDC_ARB

  console.info(
    `\nBridge ${
      withDestinationCall ? formatEther(amount) : formatUnits(amount, 6)
    } ${withDestinationCall ? 'ETH' : 'USDC/USDT'} from ${srcChain} --> Mainnet`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  if (!withDestinationCall) {
    const srcTokenContract = getContract({
      address: tokenToApprove,
      abi: ERC20_ABI,
      client,
    })
    await ensureBalance(srcTokenContract, signerAddress, amount)
    await ensureAllowance(
      srcTokenContract,
      signerAddress,
      lifiDiamondAddress,
      amount,
      publicClient
    )
  }

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'chainflip',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: tokenToApprove,
    receiver: signerAddress, // Always use signer address
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: withSwap,
    hasDestinationCall: withDestinationCall,
  }

  // Prepare destination swap data if needed
  const dstSwapData = withDestinationCall
    ? [
        await getUniswapDataExactETHToERC20(
          ADDRESS_UNISWAP_ETH,
          1, // Mainnet chainId
          totalAmount - gasAmount,
          ADDRESS_USDC_ETH,
          signerAddress,
          false
        ),
      ]
    : []

  const chainflipData: ChainflipFacet.ChainflipDataStruct = {
    nonEVMReceiver: '',
    dstToken: withDestinationCall ? 1 : 3, // 1 for ETH, 3 for USDC on ETH
    dstCallReceiver: RECEIVER_CHAINFLIP,
    dstCallSwapData: dstSwapData,
    gasAmount: withDestinationCall ? gasAmount : 0n,
    cfParameters: '',
  }

  // === Execute the appropriate transaction type ===
  if (withDestinationCall)
    await executeWithDestinationCall(
      lifiDiamondContract,
      bridgeData,
      chainflipData,
      amount,
      publicClient
    )
  else if (withSwap)
    await executeWithSourceSwap(
      lifiDiamondContract,
      bridgeData,
      chainflipData,
      amount,
      publicClient
    )
  else
    await executeDirect(
      lifiDiamondContract,
      bridgeData,
      chainflipData,
      publicClient
    )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
