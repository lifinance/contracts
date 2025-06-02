/**
 * Confirm Safe Transactions
 *
 * This script allows users to confirm and execute pending Safe transactions.
 * It fetches pending transactions from MongoDB, displays their details,
 * and provides options to sign and/or execute them.
 */

import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import * as dotenv from 'dotenv'
import { Hex, parseAbi, Abi, decodeFunctionData } from 'viem'

import {
  SafeTransaction,
  SafeTxDocument,
  AugmentedSafeTxDocument,
  privateKeyType,
  initializeSafeTransaction,
  hasEnoughSignatures,
  isSignedByCurrentSigner,
  wouldMeetThreshold,
  getSafeMongoCollection,
  getPendingTransactionsByNetwork,
  getNetworksToProcess,
  getPrivateKey,
  initializeSafeClient,
  decodeDiamondCut,
  decodeTransactionData,
  isAddressASafeOwner,
} from './safe-utils'
dotenv.config()

const storedResponses: Record<string, string> = {}

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

/**
 * Main function to process Safe transactions for a given network
 * @param network - Network name
 * @param privateKey - Private key of the signer (optional if useLedger is true)
 * @param privKeyType - Type of private key (SAFE_SIGNER or DEPLOYER)
 * @param pendingTxs - Pending transactions to process
 * @param pendingTransactions - MongoDB collection
 * @param rpcUrl - Optional RPC URL override
 * @param useLedger - Whether to use a Ledger device for signing
 * @param ledgerOptions - Options for Ledger connection
 */
const processTxs = async (
  network: string,
  privateKey: string | undefined,
  privKeyType: privateKeyType,
  pendingTxs: SafeTxDocument[],
  pendingTransactions: any,
  rpcUrl?: string,
  useLedger?: boolean,
  ledgerOptions?: {
    derivationPath?: string
    ledgerLive?: boolean
    accountIndex?: number
  }
) => {
  consola.info(' ')
  consola.info('-'.repeat(80))

  // Initialize Safe client
  const { safe, chain, safeAddress } = await initializeSafeClient(
    network,
    privateKey,
    rpcUrl,
    useLedger,
    ledgerOptions
  )

  // Get signer address
  const signerAddress = safe.account

  consola.info('Chain:', chain.name)
  consola.info('Signer:', signerAddress)

  // Check if the current signer is an owner
  try {
    const existingOwners = await safe.getOwners()
    if (!isAddressASafeOwner(existingOwners, signerAddress)) {
      consola.error('The current signer is not an owner of this Safe')
      consola.error('Signer address:', signerAddress)
      consola.error('Current owners:', existingOwners)
      consola.error('Cannot sign or execute transactions - exiting')
      return
    }
  } catch (error) {
    consola.error(`Failed to check if signer is an owner: ${error.message}`)
    consola.error('Skipping this network and moving to the next one')
    return
  }

  /**
   * Signs a SafeTransaction
   * @param safeTransaction - The transaction to sign
   * @returns The signed transaction
   */
  const signTransaction = async (safeTransaction: SafeTransaction) => {
    consola.info('Signing transaction')
    try {
      const signedTx = await safe.signTransaction(safeTransaction)
      consola.success('Transaction signed')
      return signedTx
    } catch (error) {
      consola.error('Error signing transaction:', error)
      throw new Error(`Failed to sign transaction: ${error.message}`)
    }
  }

  /**
   * Executes a SafeTransaction and updates its status in MongoDB
   * @param safeTransaction - The transaction to execute
   */
  async function executeTransaction(safeTransaction: SafeTransaction) {
    consola.info('Preparing to execute Safe transaction...')
    try {
      // Get the Safe transaction hash for reference
      const safeTxHash = await safe.getTransactionHash(safeTransaction)
      consola.info(`Safe Transaction Hash: \u001b[36m${safeTxHash}\u001b[0m`)

      // Execute the transaction on-chain
      consola.info('Submitting execution transaction to blockchain...')
      const exec = await safe.executeTransaction(safeTransaction)

      // Log execution details with color coding
      consola.success(`Execution transaction submitted successfully!`)
      consola.info(
        `Blockchain Transaction Hash: \u001b[33m${exec.hash}\u001b[0m`
      )

      // Update MongoDB transaction status
      await pendingTransactions.updateOne(
        { safeTxHash: safeTxHash },
        { $set: { status: 'executed', executionHash: exec.hash } }
      )

      consola.success(
        `✅ Safe transaction successfully executed and recorded in database`
      )
      consola.info(`   - Safe Tx Hash:   \u001b[36m${safeTxHash}\u001b[0m`)
      consola.info(`   - Execution Hash: \u001b[33m${exec.hash}\u001b[0m`)
      consola.log(' ')
    } catch (error) {
      consola.error('❌ Error executing Safe transaction:')
      consola.error(`   ${error.message}`)
      if (error.message.includes('GS026')) {
        consola.error(
          '   This appears to be a signature validation error (GS026).'
        )
        consola.error(
          '   Possible causes: invalid signature format or incorrect signer.'
        )
      }
      throw new Error(`Transaction execution failed: ${error.message}`)
    }
  }

  // Get current threshold
  let threshold
  try {
    threshold = Number(await safe.getThreshold())
  } catch (error) {
    consola.error(`Failed to get threshold: ${error.message}`)
    throw new Error(
      `Could not get threshold for Safe ${safeAddress} on ${network}`
    )
  }

  // Filter and augment transactions with signature status
  const txs = await Promise.all(
    pendingTxs.map(
      async (tx: SafeTxDocument): Promise<AugmentedSafeTxDocument> => {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        const hasSignedAlready = isSignedByCurrentSigner(
          safeTransaction,
          signerAddress
        )
        const canExecute = hasEnoughSignatures(safeTransaction, threshold)

        return {
          ...tx,
          safeTransaction,
          hasSignedAlready,
          canExecute,
          threshold,
        }
      }
    )
  ).then((txs: AugmentedSafeTxDocument[]) =>
    txs.filter((tx) => {
      // If the transaction has enough signatures to execute AND the current signer has signed,
      // still show it so they can execute it
      if (tx.canExecute) {
        return true
      }

      // Otherwise, don't show transactions that have already been signed by the current signer
      if (tx.hasSignedAlready) {
        return false
      }

      // Show transactions that need more signatures
      return tx.safeTransaction.signatures.size < tx.threshold
    })
  )

  if (!txs.length) {
    consola.success('No pending transactions')
    return
  }

  // Sort transactions by nonce in ascending order to process them in sequence
  // This ensures we handle transactions in the correct order as required by the Safe
  for (const tx of txs.sort((a, b) => {
    if (a.safeTx.data.nonce < b.safeTx.data.nonce) return -1
    if (a.safeTx.data.nonce > b.safeTx.data.nonce) return 1
    return 0
  })) {
    let abi
    let abiInterface: Abi
    let decoded

    try {
      if (tx.safeTx.data) {
        const { functionName } = await decodeTransactionData(
          tx.safeTx.data.data as Hex
        )
        if (functionName) {
          abi = functionName
          const fullAbiString = `function ${abi}`
          abiInterface = parseAbi([fullAbiString])
          decoded = decodeFunctionData({
            abi: abiInterface,
            data: tx.safeTx.data.data as Hex,
          })
        }
      }
    } catch (error) {
      consola.warn(`Failed to decode transaction data: ${error.message}`)
    }

    consola.info('-'.repeat(80))
    consola.info('Transaction Details:')
    consola.info('-'.repeat(80))

    if (abi) {
      if (decoded && decoded.functionName === 'diamondCut') {
        await decodeDiamondCut(decoded, chain.id)
      } else {
        consola.info('Method:', abi)
        if (decoded) {
          consola.info('Decoded Data:', JSON.stringify(decoded, null, 2))
        }
      }
    }

    consola.info(`Safe Transaction Details:
    Nonce:           \u001b[32m${tx.safeTx.data.nonce}\u001b[0m
    To:              \u001b[32m${tx.safeTx.data.to}\u001b[0m
    Value:           \u001b[32m${tx.safeTx.data.value}\u001b[0m
    Operation:       \u001b[32m${
      tx.safeTx.data.operation === 0 ? 'Call' : 'DelegateCall'
    }\u001b[0m
    Data:            \u001b[32m${
      tx.safeTx.data.data?.length > 66
        ? tx.safeTx.data.data.substring(0, 66) + '...'
        : tx.safeTx.data.data
    }\u001b[0m
    Proposer:        \u001b[32m${tx.proposer}\u001b[0m
    Safe Tx Hash:    \u001b[36m${tx.safeTxHash}\u001b[0m
    Signatures:      \u001b[32m${tx.safeTransaction.signatures.size}/${
      tx.threshold
    }\u001b[0m required
    Execution Ready: \u001b[${tx.canExecute ? '32m✓' : '31m✗'}\u001b[0m`)

    const storedResponse = tx.safeTx.data.data
      ? storedResponses[tx.safeTx.data.data]
      : undefined

    // Determine available actions based on signature status
    let action: string
    if (privKeyType === privateKeyType.SAFE_SIGNER) {
      const options = ['Do Nothing', 'Sign']
      action =
        storedResponse ||
        (await consola.prompt('Select action:', {
          type: 'select',
          options,
        }))
    } else {
      const options = ['Do Nothing']
      if (!tx.hasSignedAlready) {
        options.push('Sign')
        if (wouldMeetThreshold(tx.safeTransaction, tx.threshold)) {
          options.push('Sign & Execute')
        }
      }

      if (hasEnoughSignatures(tx.safeTransaction, tx.threshold)) {
        options.push('Execute')
      }

      action =
        storedResponse ||
        (await consola.prompt('Select action:', {
          type: 'select',
          options,
        }))
    }

    if (action === 'Do Nothing') {
      continue
    }
    storedResponses[tx.safeTx.data.data!] = action

    if (action === 'Sign') {
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        const signedTx = await signTransaction(safeTransaction)
        // Update MongoDB with new signature
        await pendingTransactions.updateOne(
          { safeTxHash: tx.safeTxHash },
          {
            $set: {
              [`safeTx`]: signedTx,
            },
          }
        )
        consola.success('Transaction signed and stored in MongoDB')
      } catch (error) {
        consola.error('Error signing transaction:', error)
      }
    }

    if (action === 'Sign & Execute') {
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        const signedTx = await signTransaction(safeTransaction)
        // Update MongoDB with new signature
        await pendingTransactions.updateOne(
          { safeTxHash: tx.safeTxHash },
          {
            $set: {
              [`safeTx`]: signedTx,
            },
          }
        )
        consola.success('Transaction signed and stored in MongoDB')
        await executeTransaction(signedTx)
      } catch (error) {
        consola.error('Error signing and executing transaction:', error)
      }
    }

    if (action === 'Execute') {
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        await executeTransaction(safeTransaction)
      } catch (error) {
        consola.error('Error executing transaction:', error)
      }
    }
  }
}

/**
 * Main command definition for the script
 */
const main = defineCommand({
  meta: {
    name: 'confirm-safe-tx',
    description: 'Confirm and execute transactions in a Gnosis Safe',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
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
      type: 'number',
      description: 'Ledger account index (default: 0)',
      required: false,
    },
    derivationPath: {
      type: 'string',
      description: 'Custom derivation path for Ledger (overrides ledgerLive)',
      required: false,
    },
  },
  async run({ args }) {
    const networks = getNetworksToProcess(args.network)

    // Set up signing options
    let privateKey: string | undefined
    let keyType = privateKeyType.DEPLOYER // default value
    const useLedger = args.ledger || false
    const ledgerOptions = {
      ledgerLive: args.ledgerLive || false,
      accountIndex: args.accountIndex || 0,
      derivationPath: args.derivationPath,
    }

    // Validate that incompatible Ledger options aren't provided together
    if (args.derivationPath && args.ledgerLive) {
      throw new Error(
        "Cannot use both 'derivationPath' and 'ledgerLive' options together"
      )
    }

    // If using ledger, we don't need a private key
    if (useLedger) {
      consola.info('Using Ledger hardware wallet for signing')
      if (args.ledgerLive) {
        consola.info(
          `Using Ledger Live derivation path with account index ${ledgerOptions.accountIndex}`
        )
      } else if (args.derivationPath) {
        consola.info(`Using custom derivation path: ${args.derivationPath}`)
      } else {
        consola.info(`Using default derivation path: m/44'/60'/0'/0/0`)
      }
      privateKey = undefined
    } else if (!args.privateKey) {
      // If no private key and not using ledger, ask for key from env
      const keyChoice = await consola.prompt(
        'Which private key do you want to use from your .env file?',
        {
          type: 'select',
          options: ['PRIVATE_KEY_PRODUCTION', 'SAFE_SIGNER_PRIVATE_KEY'],
        }
      )

      privateKey = getPrivateKey(
        keyChoice as 'PRIVATE_KEY_PRODUCTION' | 'SAFE_SIGNER_PRIVATE_KEY'
      )
      keyType =
        keyChoice === 'SAFE_SIGNER_PRIVATE_KEY'
          ? privateKeyType.SAFE_SIGNER
          : privateKeyType.DEPLOYER
    } else {
      privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)
    }

    // Connect to MongoDB and fetch ALL pending transactions
    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

    // Fetch all pending transactions for the networks we're processing
    const txsByNetwork = await getPendingTransactionsByNetwork(
      pendingTransactions,
      networks
    )

    // Process transactions for each network
    for (const network of networks) {
      const networkTxs = txsByNetwork[network.toLowerCase()] || []
      await processTxs(
        network,
        privateKey,
        keyType,
        networkTxs,
        pendingTransactions,
        args.rpcUrl,
        useLedger,
        ledgerOptions
      )
    }

    // Close MongoDB connection
    await mongoClient.close()
  },
})

runMain(main)
