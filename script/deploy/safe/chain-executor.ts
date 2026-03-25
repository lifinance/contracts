/**
 * Chain-agnostic interfaces for transaction broadcasting.
 *
 * - {@link IChainExecutor} — Safe-specific `execTransaction` broadcasting.
 * - {@link IChainCaller} — Generic contract call broadcasting (any contract, any calldata).
 *
 * Each chain type (EVM, Tron, …) implements both so that scripts never branch on chain type.
 */

import type { Address, Hex, TransactionReceipt } from 'viem'

// ── Safe executor types ─────────────────────────────────────────────────────

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

// ── Generic contract-call types ─────────────────────────────────────────────

/** Parameters for a generic contract call (any contract, any calldata). */
export interface IChainCallParams {
  to: Address
  data: Hex
  value?: bigint
}

/** Result of a generic contract call on any chain. */
export interface IChainCallResult {
  /** Transaction hash (always 0x-prefixed hex). */
  hash: Hex
  /** On-chain receipt, if the chain supports synchronous confirmation. */
  receipt?: TransactionReceipt
  /** Gas used by the transaction (from receipt). */
  gasUsed?: bigint
}

/** Result of simulating a contract call (dry-run). */
export interface IChainSimulateResult {
  /** Estimated resource cost. */
  estimatedResource: bigint
  /** Label for the resource unit (for display). */
  resourceLabel: string
}

/** Strategy interface for chain-specific generic contract call broadcasting. */
export interface IChainCaller {
  /** The sender address used for broadcasting. */
  readonly senderAddress: Address
  /** Broadcast a contract call and return the result. */
  call: (params: IChainCallParams) => Promise<IChainCallResult>
  /** Simulate a contract call without broadcasting (dry-run). */
  simulate: (params: IChainCallParams) => Promise<IChainSimulateResult>
}
