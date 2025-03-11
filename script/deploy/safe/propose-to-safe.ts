/**
 * Propose to Safe
 *
 * This script proposes a transaction to a Gnosis Safe and stores it in MongoDB.
 * The transaction can later be confirmed and executed using the confirm-safe-tx script.
 */

import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import {
  Address,
  Hex,
  createPublicClient,
  http,
  createWalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { MongoClient } from 'mongodb'
import consola from 'consola'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'
import {
  OperationType,
  ViemSafe,
  storeTransactionInMongoDB,
  getSafeInfoFromContract,
} from './safe-utils'

const networks: NetworksObject = data as NetworksObject

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

    // Create a wallet client with the private key
    const account = privateKeyToAccount(`0x${args.privateKey}` as Hex)
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    })

    // Create a public client for read operations
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

    // Get the account address directly from the account object
    const senderAddress = account.address

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

    // Store transaction in MongoDB using the utility function
    try {
      const result = await storeTransactionInMongoDB(
        pendingTransactions,
        safeAddress,
        args.network,
        chain.id,
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
    } finally {
      await mongoClient.close()
    }

    consola.info('Transaction proposed')
  },
})

runMain(main)
