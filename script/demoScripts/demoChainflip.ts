import { getContract, parseUnits, Narrow, zeroAddress } from 'viem'
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
  setupEnvironment,
  ADDRESS_USDC_ARB,
  ADDRESS_USDT_ARB,
  getUniswapDataERC20toExactERC20,
  ADDRESS_UNISWAP_ARB,
} from './utils/demoScriptHelpers'

dotenv.config()

// #region ABIs
const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const CHAINFLIP_FACET_ABI = chainflipFacetArtifact.abi as Narrow<
  typeof chainflipFacetArtifact.abi
>
// #endregion

async function main() {
  const withSwap = process.argv.includes('--with-swap')
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

  // === Instantiate contracts ===
  const tokenToApprove = withSwap ? ADDRESS_USDT_ARB : ADDRESS_USDC_ARB
  const srcTokenContract = getContract({
    address: tokenToApprove,
    abi: ERC20_ABI,
    client,
  })

  const srcTokenName = (await srcTokenContract.read.name()) as string
  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as bigint
  const amount = parseUnits('10', Number(srcTokenDecimals))

  console.info(
    `\nBridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> Mainnet`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'chainflip',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: withSwap ? ADDRESS_USDC_ARB : tokenToApprove,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: withSwap,
    hasDestinationCall: false,
  }

  const chainflipData: ChainflipFacet.ChainflipDataStruct = {
    dstToken: 3, // Chainflip designator for USDC on ETH
    nonEvmAddress:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    message: '0x', // Add empty message
    gasAmount: 0n, // Add gas amount
    cfParameters: '0x', // Empty parameters as per implementation
  }

  // === Start bridging ===
  if (withSwap) {
    // Generate swap data to swap USDT -> exact USDC amount
    const swapData = await getUniswapDataERC20toExactERC20(
      ADDRESS_UNISWAP_ARB, // Uniswap router address on Arbitrum
      42161, // Arbitrum chain id
      ADDRESS_USDT_ARB, // Swap from USDT
      ADDRESS_USDC_ARB, // Swap to USDC
      amount, // The exact output amount we want in USDC
      lifiDiamondAddress, // Receiver for the swapped tokens (the diamond)
      true // requiresDeposit flag
    )

    await ensureAllowance(
      srcTokenContract,
      signerAddress,
      lifiDiamondAddress,
      swapData.fromAmount,
      publicClient
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
    await ensureAllowance(
      srcTokenContract,
      signerAddress,
      lifiDiamondAddress,
      amount,
      publicClient
    )

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
