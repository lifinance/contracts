/**
 * Network preparation and prefetch queue for confirm-safe-tx.
 * Loads Safe clients, reconciles pending rows, and augments txs off the hot path
 * so the next network is ready while the operator reviews the current one.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { consola } from 'consola'
import { type Collection } from 'mongodb'
import { type Account, type Address, type Chain } from 'viem'

import { reconcileCoverageKey, reconcileSubmittedSafeTxs } from './reconcile'
import {
  getOrInitializeSafeClient,
  hasEnoughSignatures,
  initializeSafeTransaction,
  isAddressASafeOwner,
  isSignedByCurrentSigner,
  type IAugmentedSafeTxDocument,
  type ISafeTxDocument,
  type SafeClient,
} from './safe-utils'

export interface IConfirmSafeTxNetworkContext {
  network: string
  networkKey: string
  pendingTxs: ISafeTxDocument[]
  safe: SafeClient
  chain: Chain
  safeAddress: Address
  txSafeAddress: Address
  signerAddress: Address
  threshold: number
  onChainNonce: bigint
  txs: IAugmentedSafeTxDocument[]
}

export interface IPrepareConfirmSafeTxNetworkParams {
  network: string
  pendingTxs: ISafeTxDocument[]
  pendingTransactions: Collection<ISafeTxDocument>
  privateKey?: string
  rpcUrl?: string
  useLedger?: boolean
  ledgerOptions?: {
    derivationPath?: string
    ledgerLive?: boolean
    accountIndex?: number
  }
  account?: Account
  startupReconciledKeys: ReadonlySet<string>
}

/**
 * Initializes the Safe client, reconciles in-flight rows, and builds the
 * actionable tx list for one network. Returns null when the signer cannot act.
 */
export async function prepareConfirmSafeTxNetwork(
  params: IPrepareConfirmSafeTxNetworkParams
): Promise<IConfirmSafeTxNetworkContext | null> {
  const {
    network,
    pendingTxs: initialPendingTxs,
    pendingTransactions,
    privateKey,
    rpcUrl,
    useLedger,
    ledgerOptions,
    account,
    startupReconciledKeys,
  } = params

  if (initialPendingTxs.length === 0) return null

  const txSafeAddress = initialPendingTxs[0]?.safeAddress as Address
  const { safe, chain, safeAddress } = await getOrInitializeSafeClient(
    network,
    privateKey,
    rpcUrl,
    useLedger,
    ledgerOptions,
    txSafeAddress,
    account
  )

  const signerAddress = safe.account.address
  const networkKey = network.toLowerCase()

  let existingOwners: Address[]
  try {
    existingOwners = await safe.getOwners()
    if (!isAddressASafeOwner(existingOwners, signerAddress)) return null
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.warn(
      `[${network}] Skipping prefetch — failed owner check: ${errorMsg}`
    )
    return null
  }

  let threshold: number
  let onChainNonce: bigint
  try {
    ;[threshold, onChainNonce] = await Promise.all([
      safe.getThreshold().then(Number),
      safe.getNonce(),
    ])
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.warn(
      `[${network}] Skipping prefetch — failed threshold/nonce read: ${errorMsg}`
    )
    return null
  }

  let pendingTxs = initialPendingTxs

  if (
    !isTronNetworkKey(network) &&
    !startupReconciledKeys.has(
      reconcileCoverageKey(networkKey, chain.id, safeAddress)
    )
  ) {
    try {
      await reconcileSubmittedSafeTxs(
        pendingTransactions,
        safe.getPublicClient(),
        network,
        chain.id,
        safeAddress,
        onChainNonce
      )
      pendingTxs = await pendingTransactions
        .find<ISafeTxDocument>({
          network: { $eq: networkKey },
          status: { $eq: 'pending' },
        })
        .toArray()
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.warn(`[${network}] Reconcile failed during prefetch: ${errorMsg}`)
    }
  }

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
  ).then((augmented) =>
    augmented.filter((tx) => {
      if (tx.canExecute) return true
      if (tx.hasSignedAlready) return false
      return tx.safeTransaction.signatures.size < tx.threshold
    })
  )

  if (txs.length === 0) return null

  return {
    network,
    networkKey,
    pendingTxs,
    safe,
    chain,
    safeAddress,
    txSafeAddress,
    signerAddress,
    threshold,
    onChainNonce,
    txs,
  }
}

/**
 * Prefetches network preparation work while the operator interacts with the
 * current network's prompts.
 */
export class ConfirmSafeTxPrefetchQueue {
  private readonly inflight = new Map<
    string,
    Promise<IConfirmSafeTxNetworkContext | null>
  >()

  /**
   * Starts background preparation for a network if not already in flight.
   */
  public schedule(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>
  ): void {
    const key = network.toLowerCase()
    if (this.inflight.has(key)) return

    this.inflight.set(
      key,
      prepareConfirmSafeTxNetwork({ ...params, network }).catch(
        (error: unknown) => {
          const errorMsg =
            error instanceof Error ? error.message : String(error)
          consola.warn(`[${network}] Prefetch failed: ${errorMsg}`)
          return null
        }
      )
    )
  }

  /**
   * Returns prepared context for a network, waiting on any in-flight prefetch.
   */
  public async take(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>
  ): Promise<IConfirmSafeTxNetworkContext | null> {
    const key = network.toLowerCase()
    const inflight = this.inflight.get(key)
    if (inflight) {
      this.inflight.delete(key)
      return inflight
    }

    return prepareConfirmSafeTxNetwork({ ...params, network }).catch(
      (error: unknown) => {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.warn(`[${network}] Preparation failed: ${errorMsg}`)
        return null
      }
    )
  }
}
