import { parseUnits, Narrow, zeroAddress } from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import gasZipFacetArtifact from '../../out/GasZipFacet.sol/GasZipFacet.json'
import { ILiFi } from '../../typechain'
import { SupportedChain } from './utils/demoScriptChainConfig'
import {
  addressToBytes32RightPadded,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'
import { IGasZip } from '../../typechain/GasZipFacet'

dotenv.config()

// #region ABIs
const GAS_ZIP__FACET_ABI = gasZipFacetArtifact.abi as Narrow<
  typeof gasZipFacetArtifact.abi
>
// #endregion

const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const nativeDestinationChainId = 80094 // berachain
  const gasZipDestinationChainId = 143 // berachain - custom destination chain id for gas.zip - check here (https://dev.gas.zip/gas/chain-support/outbound)

  const { publicClient, walletAccount, lifiDiamondContract } =
    await setupEnvironment(srcChain, GAS_ZIP__FACET_ABI)
  const signerAddress = walletAccount.address
  const userReceiver = addressToBytes32RightPadded(signerAddress) // <== in case of evm address
  // const userReceiver = `0x${new PublicKey(
  //   'DDMe5C8EhVhaVZRu3ukqhXF5CqnjuxhxbXBXj7pZnTw6'
  // )
  // .toBuffer()
  // .toString('hex')}` // <== in case of svm address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = zeroAddress as `0x${string}` // native token

  const amount = parseUnits('0.0005', 18) // 0.0005 * 1e18

  console.info(`Bridge ${amount} native from ${srcChain} --> Berachain`)
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(SRC_TOKEN_ADDRESS, signerAddress, amount, publicClient)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'gasZip',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: zeroAddress, // <-- native token
    receiver: NON_EVM_ADDRESS,
    destinationChainId: nativeDestinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const gasZipData: IGasZip.GasZipDataStruct = {
    receiverAddress: userReceiver,
    destinationChains: gasZipDestinationChainId,
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaGasZip(
        [bridgeData, gasZipData],
        { value: bridgeData.minAmount }
      ),
    'Starting bridge tokens via GasZip',
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
