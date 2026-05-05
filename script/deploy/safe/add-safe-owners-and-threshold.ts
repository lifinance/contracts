/**
 * Add Safe Owners and Threshold
 *
 * Proposes Safe transactions to add owners (from `config/global.json:safeOwners`
 * and/or `--owners`) and, when current threshold differs, propose a change to 3.
 * Supports a single network (`--network <name>`) or every active EVM network
 * (`--all-networks`). Signs with a Ledger by default; falls back to a private
 * key when `--ledger=false`.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
import type { Collection } from 'mongodb'
import {
  createPublicClient,
  http,
  isAddress,
  type Account,
  type Address,
} from 'viem'

import globalConfig from '../../../config/global.json'
import networksData from '../../../config/networks.json'

import type { ILedgerAccountResult } from './ledger'
import {
  getNextNonce,
  getPrivateKey,
  getSafeInfoFromContract,
  getSafeMongoCollection,
  initializeSafeClient,
  isAddressASafeOwner,
  storeTransactionInMongoDB,
  type ISafeTxDocument,
} from './safe-utils'
dotenv.config()

interface ILedgerOptions {
  derivationPath?: string
  ledgerLive?: boolean
  accountIndex?: number
}

interface IProcessNetworkDeps {
  pendingTransactions: Collection<ISafeTxDocument>
  privateKey?: string
  useLedger: boolean
  ledgerOptions?: ILedgerOptions
  ledgerAccount?: Account
  cliOwners?: Address[]
}

interface IProcessNetworkResult {
  proposalsCreated: number
  summary: string
}

interface INetworkRunResult {
  network: string
  status: 'proposed' | 'skipped' | 'failed'
  detail: string
}

const main = defineCommand({
  meta: {
    name: 'add-safe-owners-and-threshold',
    description:
      'Proposes transactions to add SAFE owners from global.json (and/or --owners) and sets threshold to 3. Single network via --network, every active EVM network via --all-networks.',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name (omit when using --all-networks)',
    },
    allNetworks: {
      type: 'boolean',
      description: 'Run on every active EVM network in networks.json',
      default: false,
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer (only used with --ledger=false)',
    },
    owners: {
      type: 'string',
      description: 'Comma-separated list of owner addresses to add',
    },
    ledger: {
      type: 'boolean',
      description: 'Use a Ledger hardware wallet for signing',
      default: true,
    },
    ledgerLive: {
      type: 'boolean',
      description: 'Use Ledger Live derivation path',
    },
    accountIndex: {
      type: 'string',
      description: 'Ledger account index (default: 0)',
    },
    derivationPath: {
      type: 'string',
      description: 'Custom derivation path for Ledger (overrides ledgerLive)',
    },
  },
  async run({ args }) {
    if (!args.network && !args.allNetworks)
      throw new Error('Provide either --network <name> or --all-networks')
    if (args.network && args.allNetworks)
      throw new Error('--network and --all-networks are mutually exclusive')

    const cliOwners = parseCliOwners(args.owners)

    const useLedger = args.ledger ?? true
    const ledgerOptions: ILedgerOptions | undefined = useLedger
      ? {
          ledgerLive: args.ledgerLive || false,
          accountIndex: args.accountIndex ? Number(args.accountIndex) : 0,
          derivationPath: args.derivationPath,
        }
      : undefined

    if (useLedger && args.derivationPath && args.ledgerLive)
      throw new Error(
        "Cannot use both 'derivationPath' and 'ledgerLive' options together"
      )

    const privateKey = useLedger
      ? undefined
      : getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)

    let ledgerResult: ILedgerAccountResult | undefined
    if (useLedger) {
      consola.info('Using Ledger hardware wallet for signing')
      const { getLedgerAccount } = await import('./ledger')
      ledgerResult = await getLedgerAccount(ledgerOptions)
    }

    const networks = resolveNetworks(args.network, args.allNetworks)
    if (!networks.length) {
      consola.warn('No networks selected — exiting')
      return
    }
    consola.info(
      `Processing ${networks.length} network(s): ${networks.join(', ')}`
    )

    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

    const results: INetworkRunResult[] = []
    try {
      for (const network of networks) {
        consola.info('='.repeat(80))
        consola.info(`Network: ${network}`)
        try {
          const r = await processNetwork(network, {
            pendingTransactions,
            privateKey,
            useLedger,
            ledgerOptions,
            ledgerAccount: ledgerResult?.account,
            cliOwners,
          })
          results.push({
            network,
            status: r.proposalsCreated > 0 ? 'proposed' : 'skipped',
            detail: r.summary,
          })
        } catch (error: unknown) {
          const errorMsg =
            error instanceof Error ? error.message : String(error)
          consola.error(`[${network}] failed: ${errorMsg}`)
          results.push({ network, status: 'failed', detail: errorMsg })
        }
      }

      printSummary(results)
    } finally {
      try {
        await mongoClient.close(true)
      } catch (error) {
        consola.warn('Error closing MongoDB connection:', error)
      }
      if (ledgerResult) {
        const { closeLedgerConnection } = await import('./ledger')
        await closeLedgerConnection(ledgerResult.transport)
      }
    }
  },
})

function parseCliOwners(raw?: string): Address[] | undefined {
  if (!raw) return undefined
  const owners = raw.split(',').map((addr) => addr.trim())
  for (const addr of owners)
    if (!isAddress(addr))
      throw new Error(
        `Invalid Ethereum address in --owners: ${addr}. Expected 0x...`
      )
  return owners as Address[]
}

function resolveNetworks(
  network: string | undefined,
  allNetworks: boolean
): string[] {
  if (allNetworks)
    return Object.entries(networksData)
      .filter(
        ([, cfg]) =>
          cfg.status === 'active' &&
          typeof cfg.safeAddress === 'string' &&
          cfg.safeAddress.startsWith('0x')
      )
      .map(([key]) => key)
  return network ? [network] : []
}

function printSummary(results: INetworkRunResult[]): void {
  consola.info('='.repeat(80))
  consola.info('Run summary:')
  const width = Math.max(...results.map((r) => r.network.length), 10)
  for (const r of results) {
    const pad = r.network.padEnd(width)
    const tag =
      r.status === 'proposed'
        ? '[32mproposed[0m'
        : r.status === 'skipped'
        ? '[33mskipped [0m'
        : '[31mfailed  [0m'
    consola.info(`  ${pad}  ${tag}  ${r.detail}`)
  }
  const failed = results.filter((r) => r.status === 'failed').length
  if (failed > 0)
    consola.warn(
      `${failed} network(s) failed — rerun those individually with --network <name>`
    )
}

async function processNetwork(
  network: string,
  deps: IProcessNetworkDeps
): Promise<IProcessNetworkResult> {
  const {
    pendingTransactions,
    privateKey,
    useLedger,
    ledgerOptions,
    ledgerAccount,
    cliOwners,
  } = deps

  const { safe, chain, safeAddress } = await initializeSafeClient(
    network,
    privateKey,
    undefined,
    useLedger,
    ledgerOptions,
    undefined,
    ledgerAccount
  )

  try {
    consola.info(`Getting Safe info for ${safeAddress} on ${network}`)
    const publicClient = createPublicClient({
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    })
    const safeInfo = await getSafeInfoFromContract(publicClient, safeAddress)

    const ownersToAdd = mergeOwners(globalConfig.safeOwners, cliOwners)
    const currentThreshold = Number(safeInfo.threshold)
    const senderAddress = safe.account.address

    consola.info('Safe Address', safeAddress)
    consola.info('Signer Address', senderAddress)
    consola.info('Current threshold:', currentThreshold)
    consola.info('Current owners:', safeInfo.owners)

    let nextNonce = await getNextNonce(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      safeInfo.nonce
    )

    const existingOwners = await safe.getOwners()
    if (!isAddressASafeOwner(existingOwners, senderAddress))
      throw new Error(
        `Signer ${senderAddress} is not an owner of Safe ${safeAddress}`
      )

    let proposalsCreated = 0
    let ownersAdded = 0
    let ownersAlreadyPresent = 0

    for (const o of ownersToAdd) {
      consola.info('-'.repeat(80))
      const owner = o as Address

      if (isAddressASafeOwner(existingOwners, owner)) {
        consola.info('Owner already exists', owner)
        ownersAlreadyPresent++
        continue
      }

      const safeTransaction = await safe.createAddOwnerTx(
        {
          ownerAddress: owner,
          threshold: BigInt(currentThreshold),
        },
        { nonce: nextNonce }
      )

      consola.info('Proposing to add owner', owner)
      const signedTx = await safe.signTransaction(safeTransaction)
      const safeTxHash = await safe.getTransactionHash(signedTx)
      consola.info('Transaction signed:', safeTxHash)

      const result = await storeTransactionInMongoDB(
        pendingTransactions,
        safe.getAddress(),
        network,
        chain.id,
        signedTx,
        safeTxHash,
        senderAddress
      )

      if (result === null) consola.info('Proposal already exists - skipping')
      else if (!result.acknowledged)
        throw new Error('MongoDB insert was not acknowledged')
      else {
        consola.success('Transaction successfully stored in MongoDB')
        proposalsCreated++
      }
      ownersAdded++
      nextNonce++
    }

    consola.info('-'.repeat(80))

    let thresholdChanged = false
    if (currentThreshold !== 3) {
      const updatedOwnerCount = (await safe.getOwners()).length + ownersAdded

      if (updatedOwnerCount < 3)
        throw new Error(
          `Cannot set threshold to 3 when only ${updatedOwnerCount} owner(s) would exist (would lock the Safe)`
        )

      consola.info(
        `Now proposing to change threshold from ${currentThreshold} to 3`
      )
      const changeThresholdTx = await safe.createChangeThresholdTx(3, {
        nonce: nextNonce,
      })
      const signedThresholdTx = await safe.signTransaction(changeThresholdTx)
      const thresholdTxHash = await safe.getTransactionHash(signedThresholdTx)
      consola.info('Transaction signed:', thresholdTxHash)

      const thresholdResult = await storeTransactionInMongoDB(
        pendingTransactions,
        safe.getAddress(),
        network,
        chain.id,
        signedThresholdTx,
        thresholdTxHash,
        senderAddress
      )

      if (thresholdResult === null)
        consola.info('Proposal already exists - skipping')
      else if (!thresholdResult.acknowledged)
        throw new Error('MongoDB insert was not acknowledged')
      else {
        consola.success('Transaction successfully stored in MongoDB')
        proposalsCreated++
        thresholdChanged = true
      }
    } else consola.success('Threshold is already set to 3 - no action required')

    const summaryParts: string[] = []
    if (ownersAdded > 0) summaryParts.push(`${ownersAdded} addOwner`)
    if (ownersAlreadyPresent > 0)
      summaryParts.push(`${ownersAlreadyPresent} already present`)
    if (thresholdChanged) summaryParts.push('threshold→3')
    if (!summaryParts.length) summaryParts.push('no changes')

    return { proposalsCreated, summary: summaryParts.join(', ') }
  } finally {
    try {
      await safe.cleanup()
    } catch (error) {
      consola.warn(`[${network}] error during safe.cleanup():`, error)
    }
  }
}

function mergeOwners(configured: string[], cli?: Address[]): string[] {
  if (!cli || cli.length === 0) return [...configured]

  consola.info('Adding owners from command line:', cli)
  const seen = new Set<string>()
  const merged: string[] = []
  for (const addr of [...configured, ...cli]) {
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(addr)
  }
  return merged
}

runMain(main)
