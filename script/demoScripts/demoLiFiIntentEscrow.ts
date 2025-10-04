import { randomBytes } from 'crypto'

import { config } from 'dotenv'
import { getContract, type Narrow, parseUnits, zeroAddress } from 'viem'

import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import LIFIIntentFacetArtifact from '../../out/LiFiIntentEscrowFacet.sol/LiFiIntentEscrowFacet.json'
import type { ILiFi, LiFiIntentEscrowFacet } from '../../typechain'
import type { SupportedChain } from '../common/types'

import {
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const LIFIIntent_FACET_ABI = LIFIIntentFacetArtifact.abi as Narrow<
  typeof LIFIIntentFacetArtifact.abi
>

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'mainnet' // Set source chain
  const destinationChainId = 1 // Set destination chain id

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, LIFIIntent_FACET_ABI)
  const signerAddress = walletAccount.address

  if (
    !lifiDiamondAddress ||
    !lifiDiamondContract ||
    !lifiDiamondContract.write ||
    !lifiDiamondContract.write.startBridgeTokensViaLiFiIntentEscrow
  ) {
    console.error(
      'LiFiDiamond deployment not found for the selected chain/environment.'
    )
    process.exit(1)
  }

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = '' as `0x${string}` // Set the source token address here.
  const DST_TOKEN_ADDRESS = '' as `0x${string}` // Set the destination token address here.

  const LOCKTAG = '' as `0x${string}` // Set the locktag here.
  if (LOCKTAG.length !== 24 + 2) throw new Error('Invalid Locktag')

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    client,
  })

  if (
    !srcTokenContract ||
    !srcTokenContract.read ||
    !srcTokenContract.read.name ||
    !srcTokenContract.read.symbol ||
    !srcTokenContract.read.decimals
  ) {
    console.error('Could not get source token contract.')
    process.exit(1)
  }

  const srcTokenName = (await srcTokenContract.read.name()) as string
  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as bigint
  const amount = parseUnits('10', Number(srcTokenDecimals)) // 10 * 1e{source token decimals}

  console.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> ${destinationChainId}`
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

  // === In this part put necessary logic usually it's fetching quotes, estimating fees, signing messages etc. ===

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'LIFIIntent',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // Prepare quotes.

  // TODO: implement quote call to order server. Lets emulate it for now.

  const LIFIIntentData: LiFiIntentEscrowFacet.LiFiIntentEscrowDataStruct = {
    /// And calldata.
    receiverAddress: '0x' + signerAddress.replace('0x', '').padStart(64, '0'),
    depositAndRefundAddress: signerAddress,
    nonce: Math.round(Math.random() * Number.MAX_SAFE_INTEGER),
    expires: 2 ** 32 - 1, // max expiry time.
    // LIFIIntent Witness //
    fillDeadline: 2 ** 32 - 1, // max fill deadline time.
    inputOracle: '0x0000006ea400569c0040d6e5ba651c00848409be', // Polymer oracle on mainnet.
    // LIFIIntent Output //
    outputOracle: '0x0000006ea400569c0040d6e5ba651c00848409be', // Polymer oracle on mainnet.
    outputSettler: '0x00000000D7278408CE7a490015577c41e57143a5',
    outputToken: '0x' + DST_TOKEN_ADDRESS.replace('0x', '').padStart(64, '0'),
    outputAmount: amount, // TODO: Minus fee
    outputCall: '0x',
    outputContext: '0x', // Limit order.
  }

  // === Start bridging ===
  await executeTransaction(
    () => {
      if (!lifiDiamondContract.write.startBridgeTokensViaLiFiIntentEscrow) {
        console.error(
          'LiFiDiamond deployment not found for the selected chain/environment.'
        )
        process.exit(1)
      }
      const tx = lifiDiamondContract.write.startBridgeTokensViaLiFiIntentEscrow(
        [bridgeData, LIFIIntentData]
        // { value: fee } optional value
      )
      return tx
    },
    'Starting bridge tokens via LIFIIntent',
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
