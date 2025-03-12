/**
 * Propose to Safe
 *
 * This script proposes a transaction to a Gnosis Safe and stores it in MongoDB.
 * The transaction can later be confirmed and executed using the confirm-safe-tx script.
 */

import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { Address, Hex } from 'viem'
import consola from 'consola'
import {
  getSafeMongoCollection,
  getNextNonce,
  initializeSafeClient,
  getPrivateKey,
  storeTransactionInMongoDB,
  OperationType,
} from './safe-utils'

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
    // Get MongoDB collection
    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

    // Initialize Safe client
    const { safe, chain, safeAddress } = await initializeSafeClient(
      args.network,
      getPrivateKey(args.privateKey),
      args.rpcUrl
    )

    // Get the account address
    const senderAddress = safe.account

    // Get the next nonce
    const nextNonce = await getNextNonce(
      pendingTransactions,
      safeAddress,
      args.network,
      chain.id,
      await safe.getNonce()
    )

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
