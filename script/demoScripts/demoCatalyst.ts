import { randomBytes } from 'crypto'

import { config } from 'dotenv'
import { getContract, parseUnits, zeroAddress, type Narrow } from 'viem'

import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import LIFIIntentFacetArtifact from '../../out/LIFIIntentFacet.sol/LIFIIntentFacet.json'
import type { ILiFi, LIFIIntentFacet } from '../../typechain'
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

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = '' as `0x${string}` // Set the source token address here.
  const DST_TOKEN_ADDRESS = '' as `0x${string}` // Set the destination token address here.

  const LOCKTAG = '' as `0x${string}` // Set the locktag here.
  if (LOCKTAG.length !== 24 + 2) throw new Error('Invalid Locktag')

  // If you need to retrieve a specific address from your config file
  // based on the chain and element name, use this helper function.
  //
  // First, ensure you import the relevant config file:
  // import config from '../../config/LIFIIntent.json'
  //
  // Then, retrieve the address:
  // const EXAMPLE_ADDRESS = getConfigElement(config, srcChain, 'example');
  //

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    client,
  })

  // If you need to interact with a contract, use the following helper.
  // Provide the contract address, ABI, and a client instance to initialize
  // the contract for both read and write operations.
  //
  // const exampleContract = getContract({
  //   address: EXAMPLE_ADDRESS,
  //   abi: EXAMPLE_ABI,
  //   client
  // })
  //

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

  const LIFIIntentData: LIFIIntentFacet.LIFIIntentDataStruct = {
    /// And calldata.
    receiverAddress: '0x' + signerAddress.replace('0x', '').padStart(64, '0'),
    assetId: LOCKTAG + SRC_TOKEN_ADDRESS.replace('0x', ''),
    expectedClaimHash: '0x' + ''.padEnd(64, '0'),
    user: signerAddress,
    nonce: Math.round(Math.random() * Number.MAX_SAFE_INTEGER),
    expiry: 2 ** 32, // max expiry time. TODO: Should probably be changed.
    // LIFIIntent Witness //
    fillDeadline: 2 ** 32, // max fill deadline time. TODO: Should probably be changed.
    localOracle: '0x', // TODO:
    // LIFIIntent Output //
    outputOracle: '0x', // TODO:
    outputSettler: '0x', // TODO:
    outputToken: '0x' + DST_TOKEN_ADDRESS.replace('0x', '').padStart(64, '0'),
    outputAmount: amount, // TODO: Minus fee
    outputCall: '0x',
    outputContext: '0x', // Limit order.
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaLIFIIntent(
        [bridgeData, LIFIIntentData]
        // { value: fee } optional value
      ),
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
