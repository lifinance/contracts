/**
 * Prefetching for confirm-safe-tx, at both granularities.
 *
 * Network: loads Safe clients, reconciles pending rows and augments txs off the
 * hot path, so the next network is ready while the operator reviews the current
 * one. Proposal: a generic single-slot queue the run uses to take the next
 * proposal's chain reads while the signer reads this one.
 *
 * Both are anchored rather than trusted — a prefetched result is re-checked
 * against the state it was prepared under and discarded if that moved, so
 * prefetching never turns a fresh read into a stale one.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { consola } from 'consola'
import { type Collection } from 'mongodb'
import { type Account, type Address, type Chain } from 'viem'

import { networks } from '../../utils/viemScriptHelpers'

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
  /**
   * The Safe `config/networks.json` names for this network, absent when it
   * names none. Carried separately from `safeAddress` because the client falls
   * back to the document's claim in that case, so the two agreeing there would
   * say nothing.
   */
  configuredSafeAddress?: string
  signerAddress: Address
  threshold: number
  onChainNonce: bigint
  txs: IAugmentedSafeTxDocument[]
}

/**
 * Outcome of preparing one network. A discriminated union rather than a bare
 * `context | null` so the caller can tell an actionable network apart from the
 * distinct non-actionable causes and react to each — a not-an-owner signer or a
 * failed threshold/nonce read must not look like "nothing to do".
 */
export type PrepareConfirmSafeTxNetworkResult =
  | { kind: 'ready'; context: IConfirmSafeTxNetworkContext }
  | { kind: 'nothing-actionable' }
  | { kind: 'not-owner'; signerAddress: Address; owners: Address[] }
  | { kind: 'owner-check-failed'; error: string }
  | { kind: 'read-failed'; error: string }
  | { kind: 'prepare-error'; error: string }

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
 * actionable tx list for one network.
 * @param params - Network, pending rows, signer material and reconcile coverage
 * @returns A discriminated result: `ready` with the context, or a specific
 * non-actionable cause the caller logs (or aborts on) appropriately
 */
export async function prepareConfirmSafeTxNetwork(
  params: IPrepareConfirmSafeTxNetworkParams
): Promise<PrepareConfirmSafeTxNetworkResult> {
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

  if (initialPendingTxs.length === 0) return { kind: 'nothing-actionable' }

  const txSafeAddress = initialPendingTxs[0]?.safeAddress as Address
  // The client is pointed at the Safe config names rather than at the one the
  // proposal document claims: every read that decides whether this proposal may
  // be signed — the hash recompute, the owner set, the threshold, the nonce —
  // goes through it, and a client pointed at the document's address answers for
  // whatever Safe the proposer chose. The claim survives as `txSafeAddress`, so
  // the integrity assertions can compare the two and name which disagreed.
  //
  // The document's address remains the fallback on a network config names no
  // Safe for. Refusing to build a client there would abort the run before any
  // check could print why; the assertion records the missing anchor and blocks.
  const configuredSafeAddress = networks[network.toLowerCase()]?.safeAddress
  const { safe, chain, safeAddress } = await getOrInitializeSafeClient(
    network,
    privateKey,
    rpcUrl,
    useLedger,
    ledgerOptions,
    configuredSafeAddress ? undefined : txSafeAddress,
    account
  )

  const signerAddress = safe.account.address
  const networkKey = network.toLowerCase()

  let existingOwners: Address[]
  try {
    existingOwners = await safe.getOwners()
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return { kind: 'owner-check-failed', error: errorMsg }
  }
  if (!isAddressASafeOwner(existingOwners, signerAddress))
    return { kind: 'not-owner', signerAddress, owners: existingOwners }

  let threshold: number
  let onChainNonce: bigint
  try {
    ;[threshold, onChainNonce] = await Promise.all([
      safe.getThreshold().then(Number),
      safe.getNonce(),
    ])
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return { kind: 'read-failed', error: errorMsg }
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

  if (txs.length === 0) return { kind: 'nothing-actionable' }

  return {
    kind: 'ready',
    context: {
      network,
      networkKey,
      pendingTxs,
      safe,
      chain,
      safeAddress,
      txSafeAddress,
      ...(configuredSafeAddress ? { configuredSafeAddress } : {}),
      signerAddress,
      threshold,
      onChainNonce,
      txs,
    },
  }
}

/**
 * Prefetches network preparation work while the operator interacts with the
 * current network's prompts.
 */
export class ConfirmSafeTxPrefetchQueue {
  private readonly inflight = new Map<
    string,
    Promise<PrepareConfirmSafeTxNetworkResult>
  >()

  /**
   * @param prepare - Injectable for tests; defaults to the real preparation.
   */
  public constructor(
    private readonly prepare: (
      params: IPrepareConfirmSafeTxNetworkParams
    ) => Promise<PrepareConfirmSafeTxNetworkResult> = prepareConfirmSafeTxNetwork
  ) {}

  private runPrepare(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>
  ): Promise<PrepareConfirmSafeTxNetworkResult> {
    // Unexpected throws (RPC/Ledger/init faults) become a `prepare-error`
    // result rather than a rejected promise, so a background prefetch never
    // produces an unhandled rejection and the caller decides how to react.
    return this.prepare({ ...params, network }).catch(
      (error: unknown): PrepareConfirmSafeTxNetworkResult => {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return { kind: 'prepare-error', error: errorMsg }
      }
    )
  }

  /**
   * Starts background preparation for a network if not already in flight.
   */
  public schedule(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>
  ): void {
    const key = network.toLowerCase()
    if (this.inflight.has(key)) return
    this.inflight.set(key, this.runPrepare(network, params))
  }

  /**
   * Returns the prepared result for a network, waiting on any in-flight
   * prefetch. Logs how long the caller actually waited — with an effective
   * prefetch this is ~0ms.
   *
   * A prefetched `ready` result is re-validated against the Safe's live nonce
   * before it is returned: the prefetch may have been computed minutes ago
   * (while the operator reviewed the previous network) and another signer may
   * have executed on this Safe in the meantime, which would leave the cached
   * nonce — and the reconcile that ran with it — stale. On a mismatch the
   * context is discarded and re-prepared inline, so only the cheap nonce read
   * is ever wasted, never a stale signing/execution decision.
   */
  public async take(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>
  ): Promise<PrepareConfirmSafeTxNetworkResult> {
    const key = network.toLowerCase()
    const startedAt = Date.now()
    const inflight = this.inflight.get(key)
    if (inflight) {
      this.inflight.delete(key)
      const result = await inflight
      consola.debug(
        `[${network}] Prefetched result ready after ${
          Date.now() - startedAt
        }ms wait`
      )
      return this.revalidatePrefetched(network, params, result)
    }

    const result = await this.runPrepare(network, params)
    consola.debug(
      `[${network}] Result prepared inline (no prefetch) in ${
        Date.now() - startedAt
      }ms`
    )
    return result
  }

  /**
   * Re-checks a prefetched result before it is handed to the caller, so a
   * prefetch is semantics-preserving vs the sequential (no-prefetch) path.
   * Failure kinds are re-prepared inline: the cached error may be minutes old
   * and transient (an RPC blip while the operator reviewed the previous
   * network), and without a prefetch the prepare would have run fresh right
   * now — a fresh failure still surfaces as-is. `ready` contexts go through
   * the nonce re-validation instead.
   */
  private async revalidatePrefetched(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>,
    result: PrepareConfirmSafeTxNetworkResult
  ): Promise<PrepareConfirmSafeTxNetworkResult> {
    if (
      result.kind === 'prepare-error' ||
      result.kind === 'read-failed' ||
      result.kind === 'owner-check-failed'
    ) {
      consola.warn(
        `[${network}] Prefetched preparation had failed (${result.error}) — retrying inline`
      )
      return this.runPrepare(network, params)
    }
    return this.revalidateNonce(network, params, result)
  }

  /**
   * Discards a prefetched `ready` context whose on-chain nonce advanced since
   * the prefetch ran and re-prepares it inline. A failed nonce re-read also
   * re-prepares: proceeding on a context that just failed validation would be
   * a signing/execution decision on possibly-stale state — the same reason an
   * initial threshold/nonce read failure is a fatal `read-failed` — and the
   * sequential (no-prefetch) path would have surfaced exactly that failure.
   *
   * The nonce-advance re-prepare clears the startup reconcile coverage for
   * the run: the advance means another signer executed on this Safe, so the
   * `submitted`/`pending` rows the startup sweep resolved are exactly what
   * must be reconciled and refetched again.
   */
  private async revalidateNonce(
    network: string,
    params: Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>,
    result: PrepareConfirmSafeTxNetworkResult
  ): Promise<PrepareConfirmSafeTxNetworkResult> {
    if (result.kind !== 'ready') return result
    let freshNonce: bigint
    try {
      freshNonce = await result.context.safe.getNonce()
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.warn(
        `[${network}] Nonce re-validation read failed (${errorMsg}) — re-preparing instead of trusting the prefetched context`
      )
      return this.runPrepare(network, params)
    }
    if (freshNonce === result.context.onChainNonce) return result

    consola.warn(
      `[${network}] On-chain nonce advanced ${result.context.onChainNonce} → ` +
        `${freshNonce} since prefetch — re-preparing to avoid stale state`
    )
    return this.runPrepare(network, {
      ...params,
      startupReconciledKeys: new Set<string>(),
    })
  }
}

export type DeferredLogLevel = 'info' | 'warn' | 'error'

export interface IDeferredLine {
  level: DeferredLogLevel
  message: string
}

/**
 * A console the prefetch writes to instead of the terminal.
 *
 * Without it a background prepare's warnings land in the middle of the proposal
 * the signer is currently reading, attached to nothing — and a warning about
 * another proposal, printed under this one's verdicts, is worse than no
 * warning.
 */
export interface IDeferredLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  readonly lines: readonly IDeferredLine[]
}

export const createDeferredLogger = (): IDeferredLogger => {
  const lines: IDeferredLine[] = []
  const push =
    (level: DeferredLogLevel) =>
    (message: string): void => {
      lines.push({ level, message })
    }
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    lines,
  }
}

export interface IPrefetchedEvidence<T> {
  value: T
  /** False when the value was computed inline, whether or not a prefetch ran. */
  prefetched: boolean
  /** How long ago the prefetched reads were started; 0 for an inline value. */
  ageMs: number
  /** Why a prefetched value was thrown away, when one was. */
  discarded?: string
}

/**
 * Prefetches one proposal's chain reads while the signer reads the previous
 * proposal.
 *
 * Keyed on whatever identifies a proposal to the caller, compared by identity:
 * the document itself keys it unambiguously, where two rows carrying one
 * `safeTxHash` could not.
 *
 * One slot, so at most one proposal is ever prepared ahead. The win is the
 * interval in which a human is reading; depth beyond that buys nothing and
 * widens the window in which a prefetched read can go stale.
 *
 * The anchor is what makes this semantics-preserving. It is resolved once
 * before the reads start and again before they are handed over, and the
 * prefetch is used only if the two agree — so a value is served only when
 * nothing it rests on moved while it sat in the slot. An anchor that cannot be
 * resolved at either end is not an agreement: the value is discarded and
 * recomputed inline, which is what the signer would have got without a
 * prefetch at all.
 */
export class ProposalEvidencePrefetchQueue<TKey, TValue> {
  private slot:
    | {
        key: TKey
        startedAt: number
        promise: Promise<{ anchor: string | undefined; value: TValue }>
      }
    | undefined

  /**
   * @param onFailure - Turns an unexpected throw into a value. A prefetch that
   * threw must still hand the caller something every check can be graded from:
   * a check that reports nothing is absent from the run's ledger, which reads
   * as a check that was never owed rather than as one that could not be made.
   */
  public constructor(private readonly onFailure: (error: unknown) => TValue) {}

  /**
   * Starts preparing `key` in the background, replacing whatever was queued.
   */
  public schedule(
    key: TKey,
    compute: () => Promise<TValue>,
    resolveAnchor: () => Promise<string | undefined>
  ): void {
    if (this.slot?.key === key) return
    this.slot = {
      key,
      startedAt: Date.now(),
      promise: this.runBackground(compute, resolveAnchor),
    }
  }

  private runBackground(
    compute: () => Promise<TValue>,
    resolveAnchor: () => Promise<string | undefined>
  ): Promise<{ anchor: string | undefined; value: TValue }> {
    // The anchor is read before the work, not after: a read taken while the
    // anchor was moving must not be able to present itself as one taken after
    // it settled.
    return (async () => {
      const anchor = await resolveAnchor()
      return { anchor, value: await compute() }
    })().catch((error: unknown) => ({
      anchor: undefined,
      value: this.onFailure(error),
    }))
  }

  /**
   * Returns `key`'s evidence, using the queued prefetch only when the anchor
   * still agrees with the one it was prepared under.
   */
  public async take(
    key: TKey,
    compute: () => Promise<TValue>,
    resolveAnchor: () => Promise<string | undefined>
  ): Promise<IPrefetchedEvidence<TValue>> {
    const slot = this.slot
    this.slot = undefined

    if (!slot || slot.key !== key)
      return {
        value: await this.runInline(compute),
        prefetched: false,
        ageMs: 0,
      }

    const prepared = await slot.promise
    const discarded = await this.staleReason(prepared.anchor, resolveAnchor)
    if (discarded)
      return {
        value: await this.runInline(compute),
        prefetched: false,
        ageMs: 0,
        discarded,
      }

    return {
      value: prepared.value,
      prefetched: true,
      ageMs: Date.now() - slot.startedAt,
    }
  }

  private async staleReason(
    preparedAnchor: string | undefined,
    resolveAnchor: () => Promise<string | undefined>
  ): Promise<string | undefined> {
    if (preparedAnchor === undefined)
      return 'the prefetch could not record what state it read against'

    const current = await resolveAnchor().catch(() => undefined)
    if (current === undefined)
      return 'the state the prefetch read against could not be re-read'
    if (current !== preparedAnchor)
      return `the state moved (${preparedAnchor} → ${current}) while the prefetch sat unused`

    return undefined
  }

  private async runInline(compute: () => Promise<TValue>): Promise<TValue> {
    try {
      return await compute()
    } catch (error: unknown) {
      return this.onFailure(error)
    }
  }
}
