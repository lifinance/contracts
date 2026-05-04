/**
 * Propose to Safe
 *
 * This script proposes a transaction to a Gnosis Safe and stores it in MongoDB.
 * The transaction can later be confirmed and executed using the confirm-safe-tx script.
 *
 * Can be imported and called programmatically:
 *   import { runPropose } from './propose-to-safe'
 *   await runPropose({ network: 'mainnet', to: '0x...', calldata: '0x...', timelock: true, privateKey: '0x...' })
 *
 * Or run directly from the CLI:
 *   bun run propose-to-safe.ts --network mainnet --to 0x... --calldata 0x... --timelock --privateKey 0x...
 */

import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress, type Address, type Hex } from 'viem'

import type { IProposeToSafeOptions } from '../../common/types'

import {
  OperationTypeEnum,
  getNextNonce,
  getPrivateKey,
  getSafeMongoCollection,
  initializeSafeClient,
  isAddressASafeOwner,
  storeTransactionInMongoDB,
  wrapWithTimelockSchedule,
} from './safe-utils'

/**
 * Executes the propose-to-safe command
 * @param options - Options including network, rpcUrl, privateKey, to address, and calldata
 */
export async function runPropose(options: IProposeToSafeOptions) {
  // Set up signing options
  const useLedger = options.ledger || false
  let privateKey: string | undefined

  // Validate that incompatible Ledger options aren't provided together
  if (options.derivationPath && options.ledgerLive)
    throw new Error(
      "Cannot use both 'derivationPath' and 'ledgerLive' options together"
    )

  if (useLedger) {
    consola.info('Using Ledger hardware wallet for signing')
    if (options.ledgerLive)
      consola.info(
        `Using Ledger Live derivation path with account index ${
          options.accountIndex || 0
        }`
      )
    else if (options.derivationPath)
      consola.info(`Using custom derivation path: ${options.derivationPath}`)
    else consola.info(`Using default derivation path: m/44'/60'/0'/0/0`)

    privateKey = undefined
  } else
    privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', options.privateKey)

  const ledgerOptions = {
    ledgerLive: options.ledgerLive || false,
    accountIndex: options.accountIndex ? Number(options.accountIndex) : 0,
    derivationPath: options.derivationPath,
  }

  // Initialize Safe client (use --safeAddress override when proposing to a different Safe)
  const safeAddressOverride = options.safeAddress
    ? (getAddress(options.safeAddress) as Address)
    : undefined
  const { safe, chain, safeAddress } = await initializeSafeClient(
    options.network,
    privateKey,
    options.rpcUrl,
    useLedger,
    ledgerOptions,
    safeAddressOverride
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
    process.exit(1)
  }

  // Handle timelock wrapping if requested
  let finalTo = options.to as Address

  // Get calldata from file or argument
  let finalCalldata: Hex
  if (options.calldataFile) {
    if (!fs.existsSync(options.calldataFile))
      throw new Error(`Calldata file not found: ${options.calldataFile}`)
    finalCalldata = fs
      .readFileSync(options.calldataFile, 'utf8')
      .trim() as Hex
    consola.info(`Loaded calldata from file: ${options.calldataFile}`)
  } else if (options.calldata) {
    finalCalldata = options.calldata as Hex
  } else {
    throw new Error('Either --calldata or --calldataFile must be provided')
  }

  if (options.timelock) {
    // Look for timelock controller address in deployments (always use production)
    const deploymentPath = path.join(
      process.cwd(),
      'deployments',
      `${options.network}.json`
    )

    if (!fs.existsSync(deploymentPath))
      throw new Error(`Deployment file not found: ${deploymentPath}`)

    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
    const timelockAddress = deployments.LiFiTimelockController

    if (!timelockAddress || timelockAddress === '0x')
      throw new Error(
        `LiFiTimelockController not found in deployments for network ${options.network}`
      )

    consola.info(`Using timelock controller at ${timelockAddress}`)

    const wrappedTransaction = await wrapWithTimelockSchedule(
      options.network,
      options.rpcUrl || '',
      getAddress(timelockAddress),
      finalTo,
      finalCalldata
    )

    finalTo = wrappedTransaction.targetAddress
    finalCalldata = wrappedTransaction.calldata
  }

  // Get MongoDB collection
  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()

  // Get the next nonce
  const nextNonce = await getNextNonce(
    pendingTransactions,
    safeAddress,
    options.network,
    chain.id,
    await safe.getNonce()
  )

  // Create and sign the Safe transaction
  const safeTransaction = await safe.createTransaction({
    transactions: [
      {
        to: finalTo,
        value: 0n,
        data: finalCalldata,
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
  consola.info('Proposing transaction to', finalTo)
  if (options.timelock) {
    consola.info('Original target was', options.to)
    consola.info('Transaction wrapped in timelock schedule call')
  }

  // Store transaction in MongoDB using the utility function
  try {
    const result = await storeTransactionInMongoDB(
      pendingTransactions,
      safeAddress,
      options.network,
      chain.id,
      signedTx,
      safeTxHash,
      senderAddress
    )

    if (result === null) {
      consola.info('Proposal already exists - no new proposal created')
      return
    }

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
      required: false,
    },
    calldataFile: {
      type: 'string',
      description:
        'Path to file containing calldata (alternative to --calldata)',
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
    timelock: {
      type: 'boolean',
      description: 'Wrap the transaction in a timelock schedule call',
      required: false,
    },
    safeAddress: {
      type: 'string',
      description:
        'Override Safe address (default: from config for network). Use to propose to a different Safe (e.g. old Safe for admin transfer).',
      required: false,
    },
  },
  async run({ args }) {
    if (!args.calldata && !args.calldataFile)
      throw new Error('Either --calldata or --calldataFile must be provided')

    await runPropose({
      network: args.network,
      to: args.to,
      calldata: (args.calldata ?? '') as Hex,
      calldataFile: args.calldataFile,
      timelock: args.timelock,
      privateKey: args.privateKey,
      rpcUrl: args.rpcUrl,
      ledger: args.ledger,
      ledgerLive: args.ledgerLive,
      accountIndex: args.accountIndex ? Number(args.accountIndex) : undefined,
      derivationPath: args.derivationPath,
      safeAddress: args.safeAddress,
    })
  },
})

runMain(main)