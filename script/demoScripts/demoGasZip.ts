import { parseUnits, Narrow, zeroAddress } from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import gasZipFacetArtifact from '../../out/GasZipFacet.sol/GasZipFacet.json'
import { ILiFi } from '../../typechain'
import { SupportedChain } from './utils/demoScriptChainConfig'
import {
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

dotenv.config()

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  const destinationChainId = 143 // berachain -  custom destination chain id for gas.zip - check here (https://dev.gas.zip/gas/chain-support/outbound)

  const { publicClient, walletAccount, lifiDiamondContract } =
    await setupEnvironment(srcChain, GAS_ZIP__FACET_ABI)
  const signerAddress = walletAccount.address
  const userReceiver = addressToBytes32(signerAddress)

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = zeroAddress as `0x${string}` // native token

  const amount = parseUnits('0.001', 18) // 0.001 * 1e18

  console.info(`Bridge ${amount} native from ${srcChain} --> Optimism`)
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(SRC_TOKEN_ADDRESS, signerAddress, amount, publicClient)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'gasZip',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: zeroAddress, // <-- native token
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const gasZipData: IGasZip.GasZipDataStruct = {
    receiverAddress: userReceiver,
    destinationChains: destinationChainId,
  }

  console.log('userReceiver')
  console.log(userReceiver)

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

// does solidity's bytes32(bytes20(uint160({address})))
function addressToBytes32(address: string): string {
  // Validate that the address is a 20-byte hex string
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('Invalid Ethereum address format')
  }
  // Remove the "0x" prefix and pad the hex string to 64 characters (32 bytes)
  const hex = address.replace(/^0x/, '')
  return '0x' + hex.padStart(64, '0')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
