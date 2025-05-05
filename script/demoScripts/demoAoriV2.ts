import { getContract, parseUnits, Narrow, zeroAddress } from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import aoriV2FacetArtifact from '../../out/AoriV2Facet.sol/AoriV2Facet.json'
import { AoriV2Facet, ILiFi } from '../../typechain'
import { SupportedChain } from './utils/demoScriptChainConfig'
import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

dotenv.config()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const AORI_V2_FACET_ABI = aoriV2FacetArtifact.abi as Narrow<
  typeof aoriV2FacetArtifact.abi
>

// If you need to import a custom ABI, follow these steps:
//
// First, ensure you import the relevant artifact file:
// import exampleArtifact from '../../out/{example artifact json file}'
//
// Then, define the ABI using `Narrow<typeof exampleArtifact.abi>` for proper type inference:
// const EXAMPLE_ABI = exampleArtifact.abi as Narrow<typeof exampleArtifact.abi>
//

// #endregion

dotenv.config()

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
  } = await setupEnvironment(srcChain, AORI_V2_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = '' as `0x${string}` // Set the source token address here.

  // If you need to retrieve a specific address from your config file
  // based on the chain and element name, use this helper function.
  //
  // First, ensure you import the relevant config file:
  // import config from '../../config/aoriV2.json'
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
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> {DESTINATION CHAIN NAME}`
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
    bridge: 'aoriV2',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const aoriV2Data: AoriV2Facet.AoriV2DataStruct = {
    // Add your specific fields for AoriV2 here.
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaAoriV2(
        [bridgeData, aoriV2Data]
        // { value: fee } optional value
      ),
    'Starting bridge tokens via AoriV2',
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
