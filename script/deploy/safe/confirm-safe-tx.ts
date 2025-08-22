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
import {
  decodeFunctionData,
  parseAbi,
  type Abi,
  type Account,
  type Address,
  type Hex,
} from 'viem'

import networksData from '../../../config/networks.json'

import type { ILedgerAccountResult } from './ledger'
import {
  PrivateKeyTypeEnum,
  decodeDiamondCut,
  decodeTransactionData,
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
  shouldShowSignAndExecuteWithDeployer,
  wouldMeetThreshold,
  type IAugmentedSafeTxDocument,
  type ISafeTransaction,
  type ISafeTxDocument,
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
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

/**
 * Decodes nested timelock schedule calls that may contain diamondCut
 * @param decoded - The decoded schedule function data
 * @param chainId - Chain ID for ABI fetching
 */
async function decodeNestedTimelockCall(decoded: any, chainId: number) {
  if (decoded.functionName === 'schedule') {
    consola.info('Timelock Schedule Details:')
    consola.info('-'.repeat(80))

    const [target, value, data, predecessor, salt, delay] = decoded.args

    consola.info(`Target:      \u001b[32m${target}\u001b[0m`)
    consola.info(`Value:       \u001b[32m${value}\u001b[0m`)
    consola.info(`Predecessor: \u001b[32m${predecessor}\u001b[0m`)
    consola.info(`Salt:        \u001b[32m${salt}\u001b[0m`)
    consola.info(`Delay:       \u001b[32m${delay}\u001b[0m seconds`)
    consola.info('-'.repeat(80))

    // Try to decode the nested data
    if (data && data !== '0x')
      try {
        const nestedDecoded = await decodeTransactionData(data as Hex)
        if (nestedDecoded.functionName) {
          consola.info(
            `Nested Function: \u001b[34m${nestedDecoded.functionName}\u001b[0m`
          )

          // If the nested call is diamondCut, decode it further
          if (nestedDecoded.functionName.includes('diamondCut')) {
            const fullAbiString = `function ${nestedDecoded.functionName}`
            const abiInterface = parseAbi([fullAbiString])
            const nestedDecodedData = decodeFunctionData({
              abi: abiInterface,
              data: data as Hex,
            })

            if (nestedDecodedData.functionName === 'diamondCut') {
              consola.info('Nested Diamond Cut detected - decoding...')
              await decodeDiamondCut(nestedDecodedData, chainId)
            } else
              consola.info(
                'Nested Data:',
                JSON.stringify(nestedDecodedData, null, 2)
              )
          }
          // Decode the nested function arguments properly
          else
            try {
              const fullAbiString = `function ${nestedDecoded.functionName}`
              const abiInterface = parseAbi([fullAbiString])
              const nestedDecodedData = decodeFunctionData({
                abi: abiInterface,
                data: data as Hex,
              })

              if (nestedDecodedData.args && nestedDecodedData.args.length > 0) {
                consola.info('Nested Decoded Arguments:')
                nestedDecodedData.args.forEach((arg: any, index: number) => {
                  // Handle different types of arguments
                  let displayValue = arg
                  if (typeof arg === 'bigint') displayValue = arg.toString()
                  else if (typeof arg === 'object' && arg !== null)
                    displayValue = JSON.stringify(arg)

                  consola.info(
                    `  [${index}]: \u001b[33m${displayValue}\u001b[0m`
                  )
                })
              } else
                consola.info(
                  'No nested arguments or failed to decode nested arguments'
                )
            } catch (decodeError: any) {
              consola.warn(
                `Failed to decode nested function arguments: ${decodeError.message}`
              )
              consola.info(
                'Nested Data:',
                JSON.stringify(nestedDecoded.decodedData, null, 2)
              )
            }
        } else consola.info(`Nested Data: ${data}`)
      } catch (error: any) {
        consola.warn(`Failed to decode nested data: ${error.message}`)
        consola.info(`Raw nested data: ${data}`)
      }
  }
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
  pendingTransactions: any,
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
  } catch (error: any) {
    consola.error(`Failed to check if signer is an owner: ${error.message}`)
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
    } catch (error: any) {
      consola.error('Error signing transaction:', error)
      throw new Error(`Failed to sign transaction: ${error.message}`)
    }
  }

  /**
   * Executes a SafeTransaction and updates its status in MongoDB
   * @param safeTransaction - The transaction to execute
   * @param safeClient - The Safe client to use for execution (defaults to main safe client)
   */
  async function executeTransaction(
    safeTransaction: ISafeTransaction,
    safeClient: any = safe
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
    } catch (error: any) {
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
      // Record error in global arrays
      if (error.message.toLowerCase().includes('timeout'))
        globalTimeoutExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: error.message,
        })
      else
        globalFailedExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: error.message,
        })

      throw new Error(`Transaction execution failed: ${error.message}`)
    }
  }

  // Get current threshold
  let threshold
  try {
    threshold = Number(await safe.getThreshold())
  } catch (error: any) {
    consola.error(`Failed to get threshold: ${error.message}`)
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
    } catch (error: any) {
      consola.warn(`Failed to decode transaction data: ${error.message}`)
    }

    consola.info('-'.repeat(80))
    consola.info('Transaction Details:')
    consola.info('-'.repeat(80))

    if (abi)
      if (decoded && decoded.functionName === 'diamondCut')
        await decodeDiamondCut(decoded, chain.id)
      else if (decoded && decoded.functionName === 'schedule')
        await decodeNestedTimelockCall(decoded, chain.id)
      else {
        consola.info('Method:', abi)
        if (decoded) {
          consola.info('Function Name:', decoded.functionName)
          if (decoded.args && decoded.args.length > 0) {
            consola.info('Decoded Arguments:')
            decoded.args.forEach((arg: any, index: number) => {
              // Handle different types of arguments
              let displayValue = arg
              if (typeof arg === 'bigint') displayValue = arg.toString()
              else if (typeof arg === 'object' && arg !== null)
                displayValue = JSON.stringify(arg)

              consola.info(`  [${index}]: \u001b[33m${displayValue}\u001b[0m`)
            })
          } else consola.info('No arguments or failed to decode arguments')

          // Only show full decoded data if it contains useful information beyond what we've already shown
          if (decoded.args === undefined)
            consola.info('Full Decoded Data:', JSON.stringify(decoded, null, 2))
        }
      }

    consola.info(`Safe Transaction Details:
    Nonce:           \u001b[32m${tx.safeTx.data.nonce}\u001b[0m
    To:              \u001b[32m${tx.safeTx.data.to}\u001b[0m
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
    const useLedger = args.ledger || false
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
      } catch (error: any) {
        consola.error(`Failed to connect to Ledger: ${error.message}`)
        throw error
      }

    try {
      // Connect to MongoDB early to use it for network detection
      const { client: mongoClient, pendingTransactions } =
        await getSafeMongoCollection()

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
        // Get only networks with pending transactions
        networks = await getNetworksWithPendingTransactions(pendingTransactions)

        if (networks.length === 0) {
          consola.info('No networks have pending transactions')
          await mongoClient.close(true)
          return
        }

        consola.info(
          `Found pending transactions on ${
            networks.length
          } network(s): ${networks.join(', ')}`
        )
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
