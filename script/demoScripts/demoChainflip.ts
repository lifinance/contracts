import {
  getContract,
  parseUnits,
  Narrow,
  zeroAddress,
  encodeAbiParameters,
  formatEther,
  formatUnits,
} from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import chainflipFacetArtifact from '../../out/ChainflipFacet.sol/ChainflipFacet.json'
import { ChainflipFacet, ILiFi } from '../../typechain'
import { SupportedChain } from './utils/demoScriptChainConfig'
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
import deployments from '../../deployments/mainnet.staging.json'

dotenv.config()

const RECEIVER_CHAINFLIP = deployments.ReceiverChainflip
const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const CHAINFLIP_FACET_ABI = chainflipFacetArtifact.abi as Narrow<
  typeof chainflipFacetArtifact.abi
>

async function createDestinationCallMessage(
  transactionId: string,
  finalReceiver: string,
  totalETHAmount: bigint,
  gasAmount: bigint
): Promise<string> {
  // Calculate exact ETH amount for swap (total - gas)
  const swapETHAmount = totalETHAmount - gasAmount

  // Get swap data for ETH -> USDC on mainnet
  const swapData = await getUniswapDataExactETHToERC20(
    ADDRESS_UNISWAP_ETH,
    1, // Mainnet chainId
    swapETHAmount,
    ADDRESS_USDC_ETH,
    finalReceiver,
    false
  )

  // Encode the complete message for the receiver contract
  return encodeAbiParameters(
    [
      { type: 'bytes32' }, // transactionId
      {
        type: 'tuple[]',
        components: [
          { type: 'address', name: 'callTo' },
          { type: 'address', name: 'approveTo' },
          { type: 'address', name: 'sendingAssetId' },
          { type: 'address', name: 'receivingAssetId' },
          { type: 'uint256', name: 'fromAmount' },
          { type: 'bytes', name: 'callData' },
          { type: 'bool', name: 'requiresDeposit' },
        ],
      }, // swapData
      { type: 'address' }, // receiver
    ],
    [transactionId, [swapData], finalReceiver]
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
    receiver: withDestinationCall ? RECEIVER_CHAINFLIP : signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: withSwap,
    hasDestinationCall: withDestinationCall,
  }

  // Prepare destination call data if needed
  const destinationCallMessage = withDestinationCall
    ? await createDestinationCallMessage(
        bridgeData.transactionId,
        signerAddress,
        totalAmount,
        gasAmount
      )
    : ''

  const chainflipData: ChainflipFacet.ChainflipDataStruct = {
    nonEVMReceiver:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    dstToken: withDestinationCall ? 1 : 3, // 1 for ETH, 3 for USDC on ETH
    message: destinationCallMessage,
    gasAmount: withDestinationCall ? gasAmount : 0n,
    cfParameters: '',
  }

  // === Execute the transaction ===
  if (withDestinationCall) {
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
  } else if (withSwap) {
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
  } else {
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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
