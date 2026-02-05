/**
 * Confirm Safe Transactions
 *
 * This script allows users to confirm and execute pending Safe transactions.
 * It fetches pending transactions from MongoDB, displays their details,
 * and provides options to sign and/or execute them.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
import { type Collection } from 'mongodb'
import type { Account, Address, Hex } from 'viem'

import networksData from '../../../config/networks.json'

import type { ILedgerAccountResult } from './ledger'
import {
  formatDecodedTxDataForDisplay,
  getTargetName,
} from './safe-decode-utils'
import {
  getNetworksWithActionableTransactions,
  getNetworksWithPendingTransactions,
  getPendingTransactionsByNetwork,
  getPrivateKey,
  getSafeMongoCollection,
  hasEnoughSignatures,
  initializeSafeClient,
  initializeSafeTransaction,
  isAddressASafeOwner,
  isSignedByCurrentSigner,
  isSignedByProductionWallet,
  PrivateKeyTypeEnum,
  shouldShowSignAndExecuteWithDeployer,
  wouldMeetThreshold,
  type IAugmentedSafeTxDocument,
  type ISafeTransaction,
  type ISafeTxDocument,
  type ViemSafe,
} from './safe-utils'

dotenv.config()

const storedResponses: Record<string, string> = {}

// Global arrays to record execution failures and timeouts
const globalFailedExecutions: Array<{
  chain: string
  safeTxHash: string
  error: string
}> = []
const globalTimeoutExecutions: Array<{
  chain: string
  safeTxHash: string
  error: string
}> = []

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
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
  privKeyType: PrivateKeyTypeEnum,
  pendingTxs: ISafeTxDocument[],
  pendingTransactions: Collection<ISafeTxDocument>,
  rpcUrl?: string,
  useLedger?: boolean,
  ledgerOptions?: {
    derivationPath?: string
    ledgerLive?: boolean
    accountIndex?: number
  },
  account?: Account
) => {
  consola.info(' ')
  consola.info('-'.repeat(80))

  // Initialize Safe client using safeAddress from first transaction
  const txSafeAddress = pendingTxs[0]?.safeAddress as Address
  const { safe, chain, safeAddress } = await initializeSafeClient(
    network,
    privateKey,
    rpcUrl,
    useLedger,
    ledgerOptions,
    txSafeAddress,
    account
  )

  // Get signer address
  const signerAddress = safe.account.address

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
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.error(`Failed to check if signer is an owner: ${errorMsg}`)
    consola.error('Skipping this network and moving to the next one')
    return
  }

  /**
   * Signs a SafeTransaction
   * @param safeTransaction - The transaction to sign
   * @returns The signed transaction
   */
  const signTransaction = async (safeTransaction: ISafeTransaction) => {
    consola.info('Signing transaction')
    try {
      const signedTx = await safe.signTransaction(safeTransaction)
      consola.success('Transaction signed')
      return signedTx
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error('Error signing transaction:', error)
      throw new Error(`Failed to sign transaction: ${errorMsg}`)
    }
  }

  /**
   * Executes a SafeTransaction and updates its status in MongoDB
   * @param safeTransaction - The transaction to execute
   * @param safeClient - The Safe client to use for execution (defaults to main safe client)
   */
  async function executeTransaction(
    safeTransaction: ISafeTransaction,
    safeClient: ViemSafe = safe
  ) {
    consola.info('Preparing to execute Safe transaction...')
    let safeTxHash = ''
    try {
      // Get the Safe transaction hash for reference
      safeTxHash = await safeClient.getTransactionHash(safeTransaction)
      consola.info(`Safe Transaction Hash: \u001b[36m${safeTxHash}\u001b[0m`)

      // Execute the transaction on-chain (timeout/polling handled in safeClient)
      consola.info('Submitting execution transaction to blockchain...')
      const exec = await safeClient.executeTransaction(safeTransaction)
      const executionHash = exec.hash

      consola.success(`✅ Transaction submitted successfully`)

      // Update MongoDB transaction status
      await pendingTransactions.updateOne(
        { safeTxHash: safeTxHash },
        { $set: { status: 'executed', executionHash: executionHash } }
      )

      if (exec.receipt)
        consola.success(
          `✅ Safe transaction confirmed and recorded in database`
        )
      else
        consola.success(
          `✅ Safe transaction submitted and recorded in database (confirmation pending)`
        )

      consola.info(`   - Safe Tx Hash:   \u001b[36m${safeTxHash}\u001b[0m`)
      consola.info(`   - Execution Hash: \u001b[33m${executionHash}\u001b[0m`)
      consola.log(' ')
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error('❌ Error executing Safe transaction:')
      consola.error(`   ${errorMsg}`)
      if (errorMsg.includes('GS026')) {
        consola.error(
          '   This appears to be a signature validation error (GS026).'
        )
        consola.error(
          '   Possible causes: invalid signature format or incorrect signer.'
        )
      }
      if (errorMsg.includes('GS013')) {
        consola.error(
          '   GS013 means the inner call (e.g. Timelock.schedule) failed and Safe was executed with safeTxGas=0.'
        )
        consola.error(
          `   Likely cause: safeAddress for this network (${safeAddress} from config/networks.json for "${network}") does not have TIMELOCK_PROPOSER_ROLE on the LiFiTimelockController.`
        )
        consola.error(
          '   Grant TIMELOCK_PROPOSER_ROLE (0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1) to this Safe on the timelock for this network.'
        )
      }
      // Record error in global arrays
      if (errorMsg.toLowerCase().includes('timeout'))
        globalTimeoutExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: errorMsg,
        })
      else
        globalFailedExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: errorMsg,
        })

      throw new Error(`Transaction execution failed: ${errorMsg}`)
    }
  }

  // Get current threshold
  let threshold
  try {
    threshold = Number(await safe.getThreshold())
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.error(`Failed to get threshold: ${errorMsg}`)
    throw new Error(
      `Could not get threshold for Safe ${safeAddress} on ${network}`
    )
  }

  // Filter and augment transactions with signature status
  const txs = await Promise.all(
    pendingTxs.map(
      async (tx: ISafeTxDocument): Promise<IAugmentedSafeTxDocument> => {
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
  ).then((txs: IAugmentedSafeTxDocument[]) =>
    txs.filter((tx) => {
      // If the transaction has enough signatures to execute AND the current signer has signed,
      // still show it so they can execute it
      if (tx.canExecute) return true

      // Otherwise, don't show transactions that have already been signed by the current signer
      if (tx.hasSignedAlready) return false

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
    consola.info('-'.repeat(80))
    consola.info('Transaction Details:')
    consola.info('-'.repeat(80))

    if (tx.safeTx.data?.data)
      await formatDecodedTxDataForDisplay(tx.safeTx.data.data as Hex, {
        chainId: chain.id,
        network,
      })

    // Get target name for display
    const targetName = await getTargetName(tx.safeTx.data.to, network)
    const toDisplay = targetName
      ? `${tx.safeTx.data.to} \u001b[33m${targetName}\u001b[0m`
      : tx.safeTx.data.to

    consola.info(`Safe Transaction Details:
    Nonce:           \u001b[32m${tx.safeTx.data.nonce}\u001b[0m
    To:              \u001b[32m${toDisplay}\u001b[0m
    Value:           \u001b[32m${tx.safeTx.data.value}\u001b[0m
    Operation:       \u001b[32m${
      tx.safeTx.data.operation === 0 ? 'Call' : 'DelegateCall'
    }\u001b[0m
    Data:            \u001b[32m${tx.safeTx.data.data}\u001b[0m
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
    if (privKeyType === PrivateKeyTypeEnum.SAFE_SIGNER) {
      const options = ['Do Nothing']
      if (!tx.hasSignedAlready) {
        options.push('Sign')

        // Check if signing with current user + deployer (if needed) would meet threshold
        if (
          shouldShowSignAndExecuteWithDeployer(
            tx.safeTransaction,
            tx.threshold,
            signerAddress
          )
        )
          options.push('Sign and Execute With Deployer')
      }

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
        if (wouldMeetThreshold(tx.safeTransaction, tx.threshold))
          options.push('Sign & Execute')

        // Check if signing with current user + deployer (if needed) would meet threshold
        if (
          shouldShowSignAndExecuteWithDeployer(
            tx.safeTransaction,
            tx.threshold,
            signerAddress
          )
        )
          options.push('Sign and Execute With Deployer')
      }

      if (hasEnoughSignatures(tx.safeTransaction, tx.threshold))
        options.push('Execute')

      action =
        storedResponse ||
        (await consola.prompt('Select action:', {
          type: 'select',
          options,
        }))
    }

    if (action === 'Do Nothing') continue

    // eslint-disable-next-line require-atomic-updates
    storedResponses[tx.safeTx.data.data] = action

    if (action === 'Sign')
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

    if (action === 'Sign & Execute')
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

    if (action === 'Sign and Execute With Deployer')
      try {
        // Step 1: Sign with current user
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        const signedTx = await signTransaction(safeTransaction)

        // Step 2: Update MongoDB with current user's signature
        await pendingTransactions.updateOne(
          { safeTxHash: tx.safeTxHash },
          {
            $set: {
              [`safeTx`]: signedTx,
            },
          }
        )
        consola.success('Transaction signed and stored in MongoDB')

        // Step 3: Initialize deployer Safe client
        consola.info('Initializing deployer wallet...')
        const deployerPrivateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
        const { safe: deployerSafe } = await initializeSafeClient(
          network,
          deployerPrivateKey,
          rpcUrl,
          false, // Not using ledger for deployer
          undefined,
          txSafeAddress
        )

        // Step 4: Check if deployer needs to sign
        const needsDeployerSignature = !isSignedByProductionWallet(signedTx)
        let finalTx = signedTx

        if (needsDeployerSignature) {
          consola.info('Deployer signature needed - signing with deployer...')
          // Sign with deployer
          const deployerSignedTx = await deployerSafe.signTransaction(signedTx)

          // Update MongoDB with deployer's signature
          await pendingTransactions.updateOne(
            { safeTxHash: tx.safeTxHash },
            {
              $set: {
                [`safeTx`]: deployerSignedTx,
              },
            }
          )
          consola.success(
            'Transaction signed with deployer and stored in MongoDB'
          )
          finalTx = deployerSignedTx
        } else
          consola.info(
            'Deployer has already signed - proceeding to execution...'
          )

        // Step 5: Execute with deployer using shared executeTransaction function
        const executeWithDeployer = async (
          safeTransaction: ISafeTransaction
        ) => {
          consola.info('Executing transaction with deployer wallet...')
          await executeTransaction(safeTransaction, deployerSafe)
        }

        await executeWithDeployer(finalTx)
      } catch (error) {
        consola.error(
          'Error signing and executing transaction with deployer:',
          error
        )
      }

    if (action === 'Execute')
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        await executeTransaction(safeTransaction)
      } catch (error) {
        consola.error('Error executing transaction:', error)
      }
  }
  try {
    await safe.cleanup()
  } catch (e) {
    consola.error('Error:', e)
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
      default: true,
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
  async run({ args }) {
    // Set up signing options
    let privateKey: string | undefined
    let keyType = PrivateKeyTypeEnum.DEPLOYER // default value
    const useLedger = args.ledger ?? true
    const ledgerOptions = {
      ledgerLive: args.ledgerLive || false,
      accountIndex: args.accountIndex ? Number(args.accountIndex) : 0,
      derivationPath: args.derivationPath,
    }

    // Validate that incompatible Ledger options aren't provided together
    if (args.derivationPath && args.ledgerLive)
      throw new Error(
        "Cannot use both 'derivationPath' and 'ledgerLive' options together"
      )

    // If using ledger, we don't need a private key
    if (useLedger) {
      consola.info('Using Ledger hardware wallet for signing')
      if (args.ledgerLive)
        consola.info(
          `Using Ledger Live derivation path with account index ${ledgerOptions.accountIndex}`
        )
      else if (args.derivationPath)
        consola.info(`Using custom derivation path: ${args.derivationPath}`)
      else consola.info(`Using default derivation path: m/44'/60'/0'/0/0`)

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
          ? PrivateKeyTypeEnum.SAFE_SIGNER
          : PrivateKeyTypeEnum.DEPLOYER
    } else privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)

    // Create ledger connection once if using ledger
    let ledgerResult: ILedgerAccountResult | undefined
    if (useLedger)
      try {
        const { getLedgerAccount } = await import('./ledger')
        ledgerResult = await getLedgerAccount(ledgerOptions)
        consola.success('Ledger connected successfully for all networks')
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.error(`Failed to connect to Ledger: ${errorMsg}`)
        throw error
      }

    try {
      // Connect to MongoDB early to use it for network detection
      const { client: mongoClient, pendingTransactions } =
        await getSafeMongoCollection()

      // Get signer address early (needed for filtering actionable networks)
      let signerAddress: Address
      if (useLedger && ledgerResult?.account) {
        signerAddress = ledgerResult.account.address
      } else if (privateKey) {
        const { privateKeyToAccount } = await import('viem/accounts')
        const account = privateKeyToAccount(`0x${privateKey}` as Hex)
        signerAddress = account.address
      } else {
        throw new Error('No signer available (missing private key or Ledger)')
      }

      let networks: string[]

      if (args.network) {
        // If a specific network is provided, validate it exists and is active
        const networkConfig =
          networksData[args.network.toLowerCase() as keyof typeof networksData]
        if (!networkConfig)
          throw new Error(`Network ${args.network} not found in networks.json`)

        if (networkConfig.status !== 'active')
          throw new Error(`Network ${args.network} is not active`)

        networks = [args.network]
      } else {
        // First, get all networks with pending transactions (for informational purposes)
        const allNetworksWithPendingTxs =
          await getNetworksWithPendingTransactions(pendingTransactions)

        if (allNetworksWithPendingTxs.length === 0) {
          consola.info('No networks have pending transactions')
          await mongoClient.close(true)
          return
        }

        consola.info(
          `Found pending transactions on ${
            allNetworksWithPendingTxs.length
          } network(s): ${allNetworksWithPendingTxs.join(', ')}`
        )
        consola.info(`Checking ownership for signer: ${signerAddress}`)

        // Filter to only networks where the user can take action (is a Safe owner)
        networks = await getNetworksWithActionableTransactions(
          pendingTransactions,
          signerAddress,
          privateKey,
          useLedger,
          ledgerOptions,
          ledgerResult?.account,
          args.rpcUrl
        )

        if (networks.length === 0) {
          consola.info(
            'No networks found where you can take action. All pending transactions are either already signed by you or have enough signatures to execute.'
          )
          consola.info('Check the summary above for details on each network.')
          await mongoClient.close(true)
          return
        }

        // Show which networks are actionable
        if (networks.length < allNetworksWithPendingTxs.length) {
          const nonActionableNetworks = allNetworksWithPendingTxs.filter(
            (n) => !networks.includes(n)
          )
          consola.info(
            `You can take action on ${
              networks.length
            } network(s): ${networks.join(', ')}`
          )
          consola.info(
            `Skipping ${
              nonActionableNetworks.length
            } network(s) where you are not a Safe owner: ${nonActionableNetworks.join(
              ', '
            )}`
          )
        } else {
          consola.info(
            `You can take action on all ${networks.length} network(s) with pending transactions`
          )
        }
      }

      // Fetch all pending transactions for the networks we're processing
      const txsByNetwork = await getPendingTransactionsByNetwork(
        pendingTransactions,
        networks
      )

      // Process transactions for each network
      for (const network of networks) {
        const networkTxs = txsByNetwork[network.toLowerCase()]
        if (!networkTxs || networkTxs.length === 0)
          // This should not happen with our new approach, but keep as safety check
          continue

        await processTxs(
          network,
          privateKey,
          keyType,
          networkTxs,
          pendingTransactions,
          args.rpcUrl,
          useLedger,
          ledgerOptions,
          ledgerResult?.account
        )
      }

      // Close MongoDB connection
      await mongoClient.close(true)
      // Print summary of any failed or timed out executions
      if (
        globalFailedExecutions.length > 0 ||
        globalTimeoutExecutions.length > 0
      ) {
        consola.info('=== Execution Summary ===')
        if (globalFailedExecutions.length > 0) {
          consola.info('Failed Executions:')
          globalFailedExecutions.forEach((item) => {
            consola.info(
              `Chain: ${item.chain}, SafeTxHash: ${item.safeTxHash}, Error: ${item.error}`
            )
          })
        }
        if (globalTimeoutExecutions.length > 0) {
          consola.info('Timed Out Executions (saved in MongoDB):')
          globalTimeoutExecutions.forEach((item) => {
            consola.info(
              `Chain: ${item.chain}, SafeTxHash: ${item.safeTxHash}, Error: ${item.error}`
            )
          })
        }
      }
    } finally {
      // Always close ledger connection if it was created
      if (ledgerResult) {
        const { closeLedgerConnection } = await import('./ledger')
        await closeLedgerConnection(ledgerResult.transport)
      }
    }
  },
})

runMain(main)
