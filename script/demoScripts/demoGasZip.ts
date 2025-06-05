import { randomBytes } from 'crypto'

import dotenv from 'dotenv'
import { parseUnits, zeroAddress, type Narrow } from 'viem'

import gasZipFacetArtifact from '../../out/GasZipFacet.sol/GasZipFacet.json'
import type { ILiFi } from '../../typechain'
import type { IGasZip } from '../../typechain/GasZipFacet'
import type { SupportedChain } from '../types/common'

import {
  addressToBytes32RightPadded,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

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
  const nativeDestinationChainId = [80094, 8453, 324] // berachain, base, zksync
  const gasZipDestinationChainId = [143, 54, 51] // berachain, base, zksync - custom destination chain id for gas.zip - check here (https://dev.gas.zip/gas/chain-support/outbound)

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

  const amount = parseUnits('0.001', 18) // 0.001 * 1e18

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
    destinationChainId: nativeDestinationChainId[0],
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const dstChains = gasZipDestinationChainId.reduce(
    (p, c) => (p << BigInt(16)) + BigInt(c),
    BigInt(0)
  )

  const gasZipData: IGasZip.GasZipDataStruct = {
    receiverAddress: userReceiver,
    destinationChains: dstChains,
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
