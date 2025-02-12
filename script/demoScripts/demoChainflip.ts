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
  getUniswapSwapDataERC20ToERC20,
  getAmountsOutUniswap,
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
  const srcTokenAddress = withSwap ? ADDRESS_USDT_ARB : ADDRESS_USDC_ARB
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
  const srcTokenContract = getContract({
    address: srcTokenAddress,
    abi: ERC20_ABI,
    client,
  })

  const srcTokenName = (await srcTokenContract.read.name()) as string
  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as bigint
  const amount = parseUnits('10', Number(srcTokenDecimals)) // 10 USDC

  console.info(
    `\nBridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> Arbitrum`
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

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'chainflip',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: srcTokenAddress,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: withSwap,
    hasDestinationCall: false,
  }

  const chainflipData: ChainflipFacet.ChainflipDataStruct = {
    dstToken: 3, // USDC
    nonEvmAddress:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    cfParameters: '0x', // Empty parameters as per implementation
  }

  // === Start bridging ===
  if (withSwap) {
    // Get expected output from swapping the specified amount of USDT to USDC.
    const amountsOut = await getAmountsOutUniswap(
      ADDRESS_UNISWAP_ARB,
      42161,
      [ADDRESS_USDT_ARB, ADDRESS_USDC_ARB],
      amount
    )
    console.log('Swap amounts out:', amountsOut)

    // Adjust bridgeData.minAmount to a lower value to allow for slippage.
    // Here we set it to 98% of the estimated output.
    const expectedOutput = (BigInt(amountsOut[1]) * 98n) / 100n
    bridgeData.minAmount = expectedOutput
    console.log(
      'Updated bridgeData.minAmount:',
      bridgeData.minAmount.toString()
    )

    // Generate real swap data to swap USDT -> USDC.
    const swapData = await getUniswapSwapDataERC20ToERC20(
      ADDRESS_UNISWAP_ARB, // Uniswap router address on Arbitrum
      42161, // Arbitrum chain id
      ADDRESS_USDT_ARB, // Swap from USDT
      ADDRESS_USDC_ARB, // Swap to USDC
      expectedOutput, // Pass the expected output (in USDC) as the exact output amount
      lifiDiamondAddress, // Receiver for the swapped tokens (the diamond)
      true, // requiresDeposit flag
      0 // minAmountOut (0 lets the helper calculate slippage tolerance automatically)
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
