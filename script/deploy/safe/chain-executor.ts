/**
 * Chain-agnostic executor interface for Safe transaction broadcasting.
 *
 * Each chain type (EVM, Tron, …) implements {@link IChainExecutor} so that
 * {@link SafeClient} and `confirm-safe-tx.ts` never branch on chain type.
 */

import type { Address, Hex, TransactionReceipt } from 'viem'

// ── Types ────────────────────────────────────────────────────────────────────

/** Parameters passed to the executor — the chain-agnostic subset of a Safe transaction. */
export interface IChainExecutionParams {
  safeAddress: Address
  to: Address
  value: bigint
  data: Hex
  operation: number
  signatures: Hex
}

/** Result of executing a Safe transaction on any chain. */
export interface IChainExecutionResult {
  /** Transaction hash (always 0x-prefixed hex). */
  hash: Hex
  /** On-chain receipt, if the chain supports synchronous confirmation. */
  receipt?: TransactionReceipt
  /** Human-readable explorer URL for CLI display (e.g. TronScan). */
  explorerUrl?: string
  /** Formatted hash for CLI display (e.g. Tron strips 0x prefix). Falls back to `hash`. */
  displayHash?: string
}

/** Strategy interface for chain-specific Safe transaction execution. */
export interface IChainExecutor {
  executeTransaction: (
    params: IChainExecutionParams
  ) => Promise<IChainExecutionResult>
}
