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
 *
 * Multiple calls can be combined into a single timelock scheduleBatch proposal by
 * repeating --to/--calldata pairs (requires --timelock); inner calls execute in the
 * order they are passed:
 *   bun run propose-to-safe.ts --network mainnet --to 0x... --calldata 0xREMOVE --to 0x... --calldata 0xADD --timelock --privateKey 0x...
 *
 * Recovering a skipped Safe nonce:
 *   The nonce is auto-derived by default (on-chain nonce + pending proposals).
 *   If a nonce gap appears in the queue — e.g. the queue holds 58/59/60 but the
 *   Safe's on-chain nonce is stuck at 57 with no proposal for it — every
 *   higher-nonce proposal is blocked because the Safe executes strictly in
 *   order. Use --nonce to mint a proposal at the missing slot (a 0x self-call
 *   is a harmless filler), then run confirm-safe-tx to execute the queue:
 *     bunx tsx propose-to-safe.ts --network base --to <SAFE> --calldata 0x --nonce 57
 *   The override is rejected if the nonce is below the on-chain nonce or already
 *   occupied by a pending/submitted proposal.
 */

import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress, type Address, type Hex } from 'viem'

import type { IProposeToSafeOptions } from '../../common/types'

import { proposeWithDrain, type ITimelockCall } from './drain-parked-tasks'
import { normalizeProposeCalls } from './propose-calls'
import {
  OperationTypeEnum,
  getNextNonce,
  getPrivateKey,
  getSafeMongoCollection,
  initializeSafeClient,
  isAddressASafeOwner,
  storeTransactionInMongoDB,
  wrapWithTimelockSchedule,
  type IParkedTaskRef,
} from './safe-utils'

/**
 * Proposes the primary transaction, folding any parked facet-removal tasks for
 * the network into its timelock `scheduleBatch` so deferred cleanups ride along
 * in the same single signature (deferred diamond-cleanup queue,
 * DeferredDiamondCleanupQueue.md §6). The drain is best-effort and flag-gated
 * (`DRAIN_PARKED_TASKS`, default off): it prepares its removal calls before the
 * primary is signed and can never block the primary proposal — a drain problem
 * falls back to proposing the primary alone.
 *
 * @param options - Options including network, rpcUrl, privateKey, to address, and calldata
 */
export async function runPropose(options: IProposeToSafeOptions) {
  await proposeWithDrain(options, (extraTimelockCalls, parkedTaskRefs) =>
    _runPropose(options, extraTimelockCalls, parkedTaskRefs)
  )
}

/**
 * Executes the propose-to-safe command: signs and stores a single Safe proposal.
 * Optionally appends `extraTimelockCalls` as additional inner calls of the
 * timelock `scheduleBatch` (used by the drain to fold parked facet removals into
 * the same proposal) and annotates the stored record with `parkedTaskRefs`.
 * Call this directly (with no extra calls) to propose WITHOUT triggering a drain.
 *
 * @param options - Options including network, rpcUrl, privateKey, to address, and calldata
 * @param extraTimelockCalls - Extra inner calls to append to the scheduleBatch
 *   (only valid with `timelock`; empty for a plain primary proposal)
 * @param parkedTaskRefs - Origin-PR links to store on the proposal for the signer
 * @returns The proposal's Safe tx hash and whether a new record was stored
 *   (`false` = a duplicate pending intent already existed)
 * @throws If `extraTimelockCalls` are given without `timelock`, if the signer is
 *   not a Safe owner, on an invalid nonce override, or on a MongoDB store failure.
 */
export async function _runPropose(
  options: IProposeToSafeOptions,
  extraTimelockCalls: ITimelockCall[] = [],
  parkedTaskRefs?: IParkedTaskRef[]
): Promise<{ safeTxHash: Hex; stored: boolean }> {
  const normalized = normalizeProposeCalls(options)
  // Copy, never mutate: normalizeProposeCalls may alias options.to/options.calldata
  // when they are already arrays, so pushing here would corrupt the caller's input.
  const targets = [...normalized.targets]
  const calldatas = [...normalized.calldatas]

  if (extraTimelockCalls.length > 0) {
    if (!options.timelock)
      throw new Error(
        'parked-task removals can only be appended to a timelock (scheduleBatch) proposal'
      )
    for (const call of extraTimelockCalls) {
      targets.push(call.to)
      calldatas.push(call.calldata)
    }
  }

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

  // Check if the current signer is an owner. Throw (do not process.exit) so
  // proposeWithDrain can catch this and revert claimed parked tasks to queued.
  // citty's runMain still exits non-zero when the CLI path surfaces the throw.
  const existingOwners = await safe.getOwners()
  if (!isAddressASafeOwner(existingOwners, senderAddress)) {
    consola.error('The current signer is not an owner of this Safe')
    consola.error('Signer address:', senderAddress)
    consola.error('Current owners:', existingOwners)
    throw new Error(
      `Cannot propose transactions: signer ${senderAddress} is not an owner of Safe ${safeAddress}`
    )
  }

  let finalTo: Address
  let finalCalldata: Hex

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
      targets,
      calldatas
    )

    finalTo = wrappedTransaction.targetAddress
    finalCalldata = wrappedTransaction.calldata
  } else {
    // Single direct (non-timelock) proposal — validated above to be exactly one call
    finalTo = targets[0] as Address
    finalCalldata = calldatas[0] as Hex
  }

  // Get MongoDB collection
  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()

  // Resolve the nonce: an explicit --nonce override (e.g. to fill a gap that
  // blocks higher-nonce proposals) bypasses the auto-increment; otherwise pick
  // the next free nonce from the on-chain value and pending proposals.
  let nextNonce: bigint
  if (options.nonce !== undefined) {
    const onChainNonce = await safe.getNonce()
    if (options.nonce < onChainNonce)
      throw new Error(
        `--nonce ${options.nonce} is below the on-chain nonce ${onChainNonce}; it can never execute`
      )
    const collision = await pendingTransactions.findOne({
      safeAddress,
      network: options.network.toLowerCase(),
      chainId: chain.id,
      status: { $in: ['pending', 'submitted'] },
      'safeTx.data.nonce': Number(options.nonce),
    })
    if (collision)
      throw new Error(
        `A ${collision.status} proposal already occupies nonce ${options.nonce} (safeTxHash ${collision.safeTxHash})`
      )
    nextNonce = options.nonce
    consola.warn(`Using explicit nonce override: ${nextNonce}`)
  } else
    nextNonce = await getNextNonce(
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
  consola.info('Nonce', nextNonce.toString())
  consola.info('Proposing transaction to', finalTo)
  if (options.timelock) {
    consola.info('Original target(s):', targets.join(', '))
    consola.info(
      `Wrapped ${targets.length} call(s) in a single timelock scheduleBatch proposal`
    )
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
      senderAddress,
      parkedTaskRefs
    )

    if (result === null) {
      consola.info('Proposal already exists - no new proposal created')
      return { safeTxHash, stored: false }
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
  return { safeTxHash, stored: true }
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
      description:
        'To address (repeatable; pair each with a --calldata to combine multiple calls into one timelock proposal)',
      required: true,
    },
    calldata: {
      type: 'string',
      description:
        'Calldata (repeatable; pair each with a --to, calls execute in the given order)',
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
    nonce: {
      type: 'string',
      description:
        'Override the Safe nonce (default: auto-derived). Use to fill a gap that blocks higher-nonce proposals. Rejected if below the on-chain nonce or already occupied by a pending/submitted proposal.',
      required: false,
    },
  },
  async run({ args }) {
    if (!args.calldata && !args.calldataFile)
      throw new Error('Either --calldata or --calldataFile must be provided')

    // Guard the load-bearing citty contract: repeated flags must parse to arrays.
    // citty 0.1.x does this; 0.2.x silently keeps only the LAST value, which
    // would drop all but one inner call (e.g. propose the addition WITHOUT the
    // whitelist removal). Cross-check against the raw argv so a citty upgrade
    // fails loudly here instead of producing a wrong proposal.
    for (const [flag, value] of [
      ['--to', args.to],
      ['--calldata', args.calldata],
    ] as const) {
      const argvCount = process.argv.filter(
        (a) => a === flag || a.startsWith(`${flag}=`)
      ).length
      const parsedCount = Array.isArray(value) ? value.length : value ? 1 : 0
      if (argvCount > 0 && argvCount !== parsedCount)
        throw new Error(
          `${flag} was passed ${argvCount} times but the argument parser produced ${parsedCount} value(s) — repeated-flag parsing is broken (citty upgrade?); aborting to avoid proposing an incomplete call batch`
        )
    }

    await runPropose({
      network: args.network,
      // citty returns a string for a single flag and an array when the flag is repeated
      to: args.to as unknown as string | string[],
      calldata: (args.calldata ?? '') as unknown as Hex | Hex[],
      calldataFile: args.calldataFile,
      timelock: args.timelock,
      privateKey: args.privateKey,
      rpcUrl: args.rpcUrl,
      ledger: args.ledger,
      ledgerLive: args.ledgerLive,
      accountIndex: args.accountIndex ? Number(args.accountIndex) : undefined,
      derivationPath: args.derivationPath,
      safeAddress: args.safeAddress,
      nonce: args.nonce !== undefined ? BigInt(args.nonce) : undefined,
    })
  },
})

runMain(main)
