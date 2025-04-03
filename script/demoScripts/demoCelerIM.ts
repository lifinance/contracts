import { parseUnits, Narrow, zeroAddress } from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import celerIMFacetArtifact from '../../out/CelerIMFacetMutable.sol/CelerIMFacetMutable.json'
import {
  CelerIM,
  ILiFi,
} from '../../typechain/CelerIMFacetBase.sol/CelerIMFacetBase'
import { SupportedChain } from './utils/demoScriptChainConfig'
import { executeTransaction, setupEnvironment } from './utils/demoScriptHelpers'

dotenv.config()

// #region ABIs

const CELER_IM_FACET_ABI = celerIMFacetArtifact.abi as Narrow<
  typeof celerIMFacetArtifact.abi
>

// #endregion

dotenv.config()

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 137 // polygon

  const { publicClient, walletAccount, lifiDiamondContract } =
    await setupEnvironment(srcChain, CELER_IM_FACET_ABI)
  const signerAddress = walletAccount.address

  const amount = parseUnits('0.0001', 18) // 0.0005 * 1e{source token decimals}

  console.info(`Bridge ${amount} native token from ${srcChain} --> Polygon`)
  console.info(`Connected wallet address: ${signerAddress}`)

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

  const celerIMData: CelerIM.CelerIMDataStruct = {
    maxSlippage: 5000,
    nonce: 1,
    callTo: zeroAddress,
    callData: '0x',
    bridgeType: 4, // MsgDataTypes.BridgeSendType.PegV2Deposit
    messageBusFee: 0,
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaCelerIM(
        [bridgeData, celerIMData],
        { value: amount }
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
