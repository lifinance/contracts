/**
 * Add Safe Owners and Threshold
 *
 * This script proposes transactions to add owners to a Safe and set the threshold.
 * It reads owner addresses from global.json and proposes transactions to add each
 * owner individually, then sets the threshold to 3.
 */

import { defineCommand, runMain } from 'citty'
import { Address, createPublicClient, http } from 'viem'
import {
  getSafeMongoCollection,
  getNextNonce,
  initializeSafeClient,
  getPrivateKey,
  ViemSafe,
  SafeTransaction,
  storeTransactionInMongoDB,
  getSafeInfoFromContract,
  isAddressASafeOwner,
} from './safe-utils'
import globalConfig from '../../../config/global.json'
import * as dotenv from 'dotenv'
import consola from 'consola'
dotenv.config()

const main = defineCommand({
  meta: {
    name: 'add-safe-owners-and-threshold',
    description:
      'Proposes transactions to add all SAFE owners from global.json to the SAFE address in networks.json and sets threshold to 3',
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
    owners: {
      type: 'string',
      description: 'Comma-separated list of owner addresses to add',
    },
  },
  async run({ args }) {
    const { network, privateKey: privateKeyArg } = args

    // Get private key
    const privateKey = getPrivateKey(privateKeyArg)

    // Connect to MongoDB
    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

    consola.info('Setting up connection to Safe contract')

    // Initialize Safe client
    const { safe, chain, safeAddress } = await initializeSafeClient(
      network,
      privateKey
    )

    // Get Safe information directly from the contract
    consola.info(`Getting Safe info for ${safeAddress} on ${network}`)
    let safeInfo
    try {
      // Create a public client for read operations
      const publicClient = createPublicClient({
        chain,
        transport: http(chain.rpcUrls.default.http[0]),
      })

      safeInfo = await getSafeInfoFromContract(publicClient, safeAddress)
    } catch (error) {
      consola.error(`Failed to get Safe info: ${error.message}`)
      throw new Error(
        `Could not get Safe info for ${safeAddress} on ${network}`
      )
    }

    // Get owners from global config and command line arguments
    let ownersToAdd = [...globalConfig.safeOwners]

    // Add owners from command line if provided
    if (args.owners) {
      const cmdLineOwners = args.owners.split(',').map((addr) => addr.trim())
      consola.info('Adding owners from command line:', cmdLineOwners)

      // Deduplicate owners by converting to lowercase and using a Set
      const uniqueOwners = new Set([
        ...ownersToAdd.map((addr) => addr.toLowerCase()),
        ...cmdLineOwners.map((addr) => addr.toLowerCase()),
      ])

      // Convert back to original format (preserving the case from either source)
      const allOwners = [...ownersToAdd, ...cmdLineOwners]
      ownersToAdd = Array.from(uniqueOwners).map(
        (lowercaseAddr) =>
          allOwners.find((addr) => addr.toLowerCase() === lowercaseAddr) ||
          lowercaseAddr
      )
    }

    const currentThreshold = Number(safeInfo.threshold)

    // Get signer address
    const senderAddress = safe.account

    consola.info('Safe Address', safeAddress)
    consola.info('Signer Address', senderAddress)
    consola.info('Current threshold:', currentThreshold)
    consola.info('Current owners:', safeInfo.owners)

    // Get the next nonce
    let nextNonce = await getNextNonce(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      safeInfo.nonce
    )

    // Fetch the list of existing owners once before the loop
    const existingOwners = await safe.getOwners()

    // Check if the current signer is an owner
    if (!isAddressASafeOwner(existingOwners, senderAddress)) {
      consola.error('The current signer is not an owner of this Safe')
      consola.error('Signer address:', senderAddress)
      consola.error('Current owners:', existingOwners)
      consola.error('Cannot propose transactions - exiting')
      await mongoClient.close()
      process.exit(1)
    }

    // Go through all owner addresses and add each of them individually
    for (const o of ownersToAdd) {
      consola.info('-'.repeat(80))
      const owner = o as Address

      if (isAddressASafeOwner(existingOwners, owner)) {
        consola.info('Owner already exists', owner)
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

      consola.info('Proposing to add owner', owner)

      await proposeTransactionToMongoDB(
        safe,
        safeTransaction,
        senderAddress,
        network,
        chain.id,
        pendingTransactions
      )
      nextNonce++
    }

    consola.info('-'.repeat(80))

    if (currentThreshold != 3) {
      consola.info(
        'Now proposing to change threshold from',
        currentThreshold,
        'to 3'
      )
      const changeThresholdTx = await safe.createChangeThresholdTx(3, {
        nonce: nextNonce,
      })
      await proposeTransactionToMongoDB(
        safe,
        changeThresholdTx,
        senderAddress,
        network,
        chain.id,
        pendingTransactions
      )
    } else consola.success('Threshold is already set to 3 - no action required')

    // Close MongoDB connection
    await mongoClient.close()

    consola.info('-'.repeat(80))
    consola.success('Script completed without errors')
  },
})

/**
 * Proposes a transaction to MongoDB
 * @param safe - ViemSafe instance
 * @param safeTransaction - The transaction to propose
 * @param senderAddress - Address of the sender
 * @param network - Network name
 * @param chainId - Chain ID
 * @param pendingTransactions - MongoDB collection
 * @returns The transaction hash
 */
async function proposeTransactionToMongoDB(
  safe: ViemSafe,
  safeTransaction: SafeTransaction,
  senderAddress: Address,
  network: string,
  chainId: number,
  pendingTransactions: any
): Promise<string> {
  // Sign the transaction
  const signedTx = await safe.signTransaction(safeTransaction)
  const safeTxHash = await safe.getTransactionHash(signedTx)

  consola.info('Transaction signed:', safeTxHash)

  // Store transaction in MongoDB using the utility function
  try {
    const result = await storeTransactionInMongoDB(
      pendingTransactions,
      await safe.getAddress(),
      network,
      chainId,
      signedTx,
      safeTxHash,
      senderAddress
    )

    if (!result.acknowledged) {
      throw new Error('MongoDB insert was not acknowledged')
    }

    consola.success('Transaction successfully stored in MongoDB')
  } catch (error) {
    consola.error('Failed to store transaction in MongoDB:', error)
    throw error
  }

  return safeTxHash
}

runMain(main)
