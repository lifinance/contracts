import { defineCommand, runMain } from 'citty'
import { Address, createPublicClient, http } from 'viem'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'
import globalConfig from '../../../config/global.json'
import * as dotenv from 'dotenv'
import { ViemSafe, ViemSafeContract, SafeTransaction } from './safe-utils'
dotenv.config()

const networks: NetworksObject = data as NetworksObject

const main = defineCommand({
  meta: {
    name: 'add-safe-owners-and-threshold',
    description:
      'Adds all SAFE owners from global.json to the SAFE address in networks.json and sets threshold to 3',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
    },
  },
  async run({ args }) {
    const { network, privateKey: privateKeyArg } = args

    const chain = getViemChainForNetworkName(network)

    const privateKey = String(
      privateKeyArg || process.env.PRIVATE_KEY_PRODUCTION
    )

    if (!privateKey)
      throw new Error(
        'Private key is missing, either provide it as argument or add PRIVATE_KEY_PRODUCTION to your .env'
      )

    console.info('Setting up connection to SAFE API')

    // Initialize the Safe contract client
    const safeContract = new ViemSafeContract({
      txServiceUrl: networks[network].safeApiUrl,
      chainId: BigInt(chain.id),
    })

    const safeAddress = networks[network].safeAddress as Address

    const rpcUrl = chain.rpcUrls.default.http[0] || args.rpcUrl

    // Initialize public client for basic chain operations
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Initialize our viem-based Safe implementation
    const safe = await ViemSafe.init({
      provider: rpcUrl,
      privateKey,
      safeAddress,
    })

    const owners = globalConfig.safeOwners

    let nextNonce = await safeContract.getNextNonce(safeAddress)
    const safeInfo = await safeContract.getSafeInfo(safeAddress)
    const currentThreshold = safeInfo?.threshold

    if (!currentThreshold)
      throw new Error('Could not get current signature threshold')

    // Get signer address
    const senderAddress = await publicClient
      .getAddresses()
      .then((addresses) => addresses[0])

    console.info('Safe Address', safeAddress)
    console.info('Signer Address', senderAddress)

    // Go through all owner addresses and add each of them individually
    for (const o of owners) {
      console.info('-'.repeat(80))
      const owner = o as Address
      const existingOwners = await safe.getOwners()

      if (
        existingOwners.map((o) => o.toLowerCase()).includes(owner.toLowerCase())
      ) {
        console.info('Owner already exists', owner)
        continue
      }

      const safeTransaction = await safe.createAddOwnerTx(
        {
          ownerAddress: owner,
          threshold: BigInt(currentThreshold),
        },
        {
          nonce: nextNonce,
        }
      )

      console.info('Adding owner', owner)

      await submitAndExecuteTransaction(
        safe,
        safeContract,
        safeTransaction,
        senderAddress
      )
      nextNonce++
    }

    console.info('-'.repeat(80))

    if (currentThreshold != 3) {
      console.info('Now changing threshold from', currentThreshold, 'to 3')
      const changeThresholdTx = await safe.createChangeThresholdTx(3)
      await submitAndExecuteTransaction(
        safe,
        safeContract,
        changeThresholdTx,
        senderAddress
      )
    } else console.log('Threshold is already set to 3 - no action required')

    console.info('-'.repeat(80))
    console.info('Script completed without errors')
  },
})

async function submitAndExecuteTransaction(
  safe: ViemSafe,
  safeContract: ViemSafeContract,
  safeTransaction: SafeTransaction,
  senderAddress: Address
): Promise<string> {
  // Sign the transaction
  const signedTx = await safe.signTransaction(safeTransaction)

  // Get the transaction hash
  const safeTxHash = await safe.getTransactionHash(signedTx)

  // Get the signature
  const signature = await safe.signHash(safeTxHash)

  // Propose the transaction to the Safe API
  await safeContract.proposeTransaction({
    safeAddress: await safe.getAddress(),
    safeTransactionData: signedTx.data,
    safeTxHash,
    senderAddress,
    senderSignature: signature.data,
  })

  console.info('Transaction proposed:', safeTxHash)

  // Execute the transaction immediately
  try {
    const execResult = await safe.executeTransaction(signedTx)
    console.info('Transaction executed:', execResult.hash)
  } catch (error) {
    console.error('Transaction execution failed:', error)
    throw error
  }

  return safeTxHash
}

runMain(main)
