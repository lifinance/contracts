import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { Address, Hex, createPublicClient, http } from 'viem'
import { MongoClient } from 'mongodb'
import consola from 'consola'
import * as chains from 'viem/chains'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'
import { OperationType, ViemSafe } from './safe-utils'

const networks: NetworksObject = data as NetworksObject

/**
 * Retries a function multiple times if it fails
 * @param func - The async function to retry
 * @param retries - Number of retries remaining
 * @returns The result of the function
 */
const retry = async <T>(func: () => Promise<T>, retries = 3): Promise<T> => {
  try {
    const result = await func()
    return result
  } catch (e) {
    consola.error('Error details:', {
      error: e,
      remainingRetries: retries - 1,
    })
    if (retries > 0) {
      return retry(func, retries - 1)
    }
    throw e
  }
}

/**
 * Main command definition for proposing transactions to a Safe
 */
const main = defineCommand({
  meta: {
    name: 'propose-to-safe',
    description: 'Propose a transaction to a Gnosis Safe',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL',
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
      required: true,
    },
    to: {
      type: 'string',
      description: 'To address',
      required: true,
    },
    calldata: {
      type: 'string',
      description: 'Calldata',
      required: true,
    },
  },
  /**
   * Executes the propose-to-safe command
   * @param args - Command arguments including network, rpcUrl, privateKey, to address, and calldata
   */
  async run({ args }) {
    const chain = getViemChainForNetworkName(args.network)

    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required')
    }

    const mongoClient = new MongoClient(process.env.MONGODB_URI)
    const db = mongoClient.db('SAFE')
    const pendingTransactions = db.collection('pendingTransactions')

    const safeAddress = networks[args.network.toLowerCase()]
      .safeAddress as Address

    const rpcUrl = args.rpcUrl || chain.rpcUrls.default.http[0]

    // Create a public client for basic chain operations
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Initialize our viem-based Safe implementation
    let safe: ViemSafe
    try {
      safe = await ViemSafe.init({
        provider: rpcUrl,
        privateKey: args.privateKey,
        safeAddress,
      })
    } catch (error) {
      consola.error('Failed to initialize Safe:', error)
      throw error
    }

    // Get the account address from the private key
    const senderAddress = await publicClient
      .getAddresses()
      .then((addresses) => addresses[0])

    // Get the latest pending transaction to determine the next nonce
    const latestTx = await pendingTransactions
      .find({
        safeAddress,
        network: args.network.toLowerCase(),
        chainId: chain.id,
        status: 'pending',
      })
      .sort({ nonce: -1 })
      .limit(1)
      .toArray()

    // Calculate the next nonce
    const nextNonce =
      latestTx.length > 0
        ? BigInt(latestTx[0].safeTx?.data?.nonce || latestTx[0].data?.nonce) +
          1n
        : await safe.getNonce()

    // Create and sign the Safe transaction
    const safeTransaction = await safe.createTransaction({
      transactions: [
        {
          to: args.to as Address,
          value: 0n,
          data: args.calldata as Hex,
          operation: OperationType.Call,
          nonce: nextNonce,
        },
      ],
    })

    const signedTx = await safe.signTransaction(safeTransaction)
    const safeTxHash = await safe.getTransactionHash(signedTx)

    consola.info('Signer Address', senderAddress)
    consola.info('Safe Address', safeAddress)
    consola.info('Network', chain.name)
    consola.info('Proposing transaction to', args.to)

    // Store transaction in MongoDB
    try {
      const txDoc = {
        safeAddress: await safe.getAddress(),
        network: args.network.toLowerCase(),
        chainId: chain.id,
        safeTx: signedTx,
        safeTxHash,
        proposer: senderAddress,
        timestamp: new Date(),
        status: 'pending',
      }

      const result = await retry(async () => {
        const insertResult = await pendingTransactions.insertOne(txDoc)
        return insertResult
      })

      if (!result.acknowledged) {
        throw new Error('MongoDB insert was not acknowledged')
      }

      consola.info('Transaction successfully stored in MongoDB')
    } catch (error) {
      consola.error('Failed to store transaction in MongoDB:', error)
      throw error
    } finally {
      await mongoClient.close()
    }

    consola.info('Transaction proposed')
  },
})

runMain(main)
