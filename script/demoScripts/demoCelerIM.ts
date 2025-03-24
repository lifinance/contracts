import { parseUnits, Narrow, zeroAddress } from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import celerIMFacetArtifact from '../../out/CelerIMFacetMutable.sol/CelerIMFacetMutable.json'
import {
  CelerIM,
  ILiFi,
} from '../../typechain/CelerIMFacetBase.sol/CelerIMFacetBase'
import { SupportedChain } from './utils/demoScriptChainConfig'
import {
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

dotenv.config()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const CELER_IM_FACET_ABI = celerIMFacetArtifact.abi as Narrow<
  typeof celerIMFacetArtifact.abi
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
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 137 // polygon

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, CELER_IM_FACET_ABI)
  const signerAddress = walletAccount.address

  const amount = parseUnits('0.0005', 18) // 0.0005 * 1e{source token decimals}

  console.info(`Bridge ${amount} native token from ${srcChain} --> Polygon`)
  console.info(`Connected wallet address: ${signerAddress}`)

  // await ensureBalance(address(0), signerAddress, amount)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'celerIM',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: zeroAddress, // native token
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const messageBusFee = 1e17

  const celerIMData: CelerIM.CelerIMDataStruct = {
    maxSlippage: 5000,
    nonce: 1,
    callTo: zeroAddress,
    callData: '0x',
    bridgeType: 0, // MsgDataTypes.BridgeSendType.Liquidity
    messageBusFee: messageBusFee,
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaCelerIM(
        [bridgeData, celerIMData],
        { value: messageBusFee }
      ),
    'Starting bridge tokens via CelerIM',
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
