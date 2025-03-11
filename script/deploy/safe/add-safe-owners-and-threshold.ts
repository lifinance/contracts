/**
 * Add Safe Owners and Threshold
 *
 * This script proposes transactions to add owners to a Safe and set the threshold.
 * It reads owner addresses from global.json and proposes transactions to add each
 * owner individually, then sets the threshold to 3.
 */

import { defineCommand, runMain } from 'citty'
import { Address, createPublicClient, http } from 'viem'
import { MongoClient } from 'mongodb'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'
import globalConfig from '../../../config/global.json'
import * as dotenv from 'dotenv'
import {
  ViemSafe,
  SafeTransaction,
  getSafeInfoFromContract,
  storeTransactionInMongoDB,
} from './safe-utils'
import consola from 'consola'
dotenv.config()

const networks: NetworksObject = data as NetworksObject

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

    const chain = getViemChainForNetworkName(network)

    const privateKey = String(
      privateKeyArg || process.env.PRIVATE_KEY_PRODUCTION
    )

    if (!privateKey)
      throw new Error(
        'Private key is missing, either provide it as argument or add PRIVATE_KEY_PRODUCTION to your .env'
      )

    // Check for MongoDB URI
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required')
    }

    // Connect to MongoDB
    const mongoClient = new MongoClient(process.env.MONGODB_URI)
    const db = mongoClient.db('SAFE')
    const pendingTransactions = db.collection('pendingTransactions')

    consola.info('Setting up connection to Safe contract')

    const safeAddress = networks[network].safeAddress as Address
    if (!safeAddress) {
      throw new Error(`No Safe address configured for network ${network}`)
    }

    const rpcUrl = chain.rpcUrls.default.http[0] || args.rpcUrl

    // Initialize public client for basic chain operations
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Initialize our viem-based Safe implementation
    let safe: ViemSafe
    try {
      safe = await ViemSafe.init({
        provider: rpcUrl,
        privateKey,
        safeAddress,
      })
    } catch (error) {
      consola.error(`Failed to initialize Safe: ${error.message}`)
      throw error
    }

    // Get Safe information directly from the contract
    consola.info(`Getting Safe info for ${safeAddress} on ${network}`)
    let safeInfo
    try {
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
      ownersToAdd = [...ownersToAdd, ...cmdLineOwners]
    }

    const currentThreshold = Number(safeInfo.threshold)

    // Get signer address
    const senderAddress = safe.account

    consola.info('Safe Address', safeAddress)
    consola.info('Signer Address', senderAddress)
    consola.info('Current threshold:', currentThreshold)
    consola.info('Current owners:', safeInfo.owners)

    // Get the latest pending transaction to determine the next nonce
    const latestTx = await pendingTransactions
      .find({
        safeAddress,
        network: network.toLowerCase(),
        chainId: chain.id,
        status: 'pending',
      })
      .sort({ nonce: -1 })
      .limit(1)
      .toArray()

    // Calculate the next nonce
    let nextNonce =
      latestTx.length > 0
        ? BigInt(latestTx[0].safeTx?.data?.nonce || latestTx[0].data?.nonce) +
          1n
        : await safe.getNonce()

    // Go through all owner addresses and add each of them individually
    for (const o of ownersToAdd) {
      consola.info('-'.repeat(80))
      const owner = o as Address
      const existingOwners = await safe.getOwners()

      if (
        existingOwners.map((o) => o.toLowerCase()).includes(owner.toLowerCase())
      ) {
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
