import {
  getContract,
  parseUnits,
  Narrow,
  zeroAddress
} from 'viem'
import { randomBytes } from 'crypto'
import { config } from 'dotenv'
import { ERC20__factory as ERC20 } from '../../typechain/factories/ERC20__factory'
import { UnitFacet__factory as UnitFacet } from '../../typechain/factories/UnitFacet.sol/UnitFacet__factory'
import { ensureBalance, ensureAllowance, executeTransaction, setupEnvironment, type SupportedChain } from './utils/demoScriptHelpers'

config()

// If you need to import a custom ABI, follow these steps:
// 
// First, ensure you import the relevant artifact file:
// import { exampleArtifact__factory } from '../../typechain/factories/{example artifact json file}'
//

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = "mainnet" // Set source chain
  const destinationChainId = 1 // Set destination chain id

  const { client, publicClient, walletAccount, lifiDiamondAddress, lifiDiamondContract } = await setupEnvironment(srcChain, UNIT_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = '' as `0x${string}` // Set the source token address here.

  // If you need to retrieve a specific address from your config file 
  // based on the chain and element name, use this helper function.
  // 
  // First, ensure you import the relevant config file:
  // import config from '../../config/unit.json'
  //
  // Then, retrieve the address:
  // const EXAMPLE_ADDRESS = getConfigElement(config, srcChain, 'example');
  //

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20.abi,
    client: publicClient
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

  const srcTokenName = await srcTokenContract.read.name() as string
  const srcTokenSymbol = await srcTokenContract.read.symbol() as string
  const srcTokenDecimals = await srcTokenContract.read.decimals() as bigint
  const amount = parseUnits('10', Number(srcTokenDecimals)); // 10 * 1e{source token decimals}

  console.info(`Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> {DESTINATION CHAIN NAME}`)
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

  await ensureAllowance(srcTokenContract, signerAddress, lifiDiamondAddress, amount, publicClient)

  // === In this part put necessary logic usually it's fetching quotes, estimating fees, signing messages etc. ===




  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'unit',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const unitData: UnitFacet.UnitDataStruct = {
    // Add your specific fields for Unit here.
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaUnit(
        [bridgeData, unitData],
        // { value: fee } optional value
      ),
    'Starting bridge tokens via Unit',
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
