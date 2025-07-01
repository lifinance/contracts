/**
 * Propose to Safe
 *
 * This script proposes a transaction to a Gnosis Safe and stores it in MongoDB.
 * The transaction can later be confirmed and executed using the confirm-safe-tx script.
 */

import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { Address, Hex } from 'viem'

import {
  getSafeMongoCollection,
  getNextNonce,
  initializeSafeClient,
  getPrivateKey,
  storeTransactionInMongoDB,
  OperationTypeEnum,
  isAddressASafeOwner,
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
      description: 'Private key of the signer (not needed if using --ledger)',
      required: false,
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
    ledger: {
      type: 'boolean',
      description: 'Use Ledger hardware wallet for signing',
      required: false,
    },
    ledgerLive: {
      type: 'boolean',
      description: 'Use Ledger Live derivation path',
      required: false,
    },
    accountIndex: {
      type: 'string',
      description: 'Ledger account index (default: 0)',
      required: false,
    },
    derivationPath: {
      type: 'string',
      description: 'Custom derivation path for Ledger (overrides ledgerLive)',
      required: false,
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

    // Validate that we have either a private key or ledger
    if (!args.privateKey && !args.ledger)
      throw new Error('Either --privateKey or --ledger must be provided')

    // Set up signing options
    const useLedger = args.ledger || false
    let privateKey: string | undefined

    // Validate that incompatible Ledger options aren't provided together
    if (args.derivationPath && args.ledgerLive)
      throw new Error(
        "Cannot use both 'derivationPath' and 'ledgerLive' options together"
      )

    if (useLedger) {
      consola.info('Using Ledger hardware wallet for signing')
      if (args.ledgerLive)
        consola.info(
          `Using Ledger Live derivation path with account index ${
            args.accountIndex || 0
          }`
        )
      else if (args.derivationPath)
        consola.info(`Using custom derivation path: ${args.derivationPath}`)
      else consola.info(`Using default derivation path: m/44'/60'/0'/0/0`)

      privateKey = undefined
    } else privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)

    const ledgerOptions = {
      ledgerLive: args.ledgerLive || false,
      accountIndex: args.accountIndex ? Number(args.accountIndex) : 0,
      derivationPath: args.derivationPath,
    }

    // Initialize Safe client
    const { safe, chain, safeAddress } = await initializeSafeClient(
      args.network,
      privateKey,
      args.rpcUrl,
      useLedger,
      ledgerOptions
    )

    // Get the account address
    const senderAddress = safe.account.address

    // Check if the current signer is an owner
    const existingOwners = await safe.getOwners()
    if (!isAddressASafeOwner(existingOwners, senderAddress)) {
      consola.error('The current signer is not an owner of this Safe')
      consola.error('Signer address:', senderAddress)
      consola.error('Current owners:', existingOwners)
      consola.error('Cannot propose transactions - exiting')
      await mongoClient.close()
      process.exit(1)
    }

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
          operation: OperationTypeEnum.Call,
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

      if (!result.acknowledged)
        throw new Error('MongoDB insert was not acknowledged')

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
