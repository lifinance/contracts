import type { TronTvmNetworkName } from '@lifi/tron-devkit'
import type { Hex } from 'viem'

export type { TronTvmNetworkName }

/** Options for the propose-to-safe-tron CLI script. */
export interface IProposeToSafeTronOptions {
  dryRun?: boolean
  /** Tron network to use — defaults to 'tron' (mainnet). Pass 'tronshasta' for staging. */
  network?: TronTvmNetworkName
  /**
   * Base58 contract address(es) for generic proposals. Repeating --to/--calldata
   * combines multiple inner calls into one timelock scheduleBatch proposal.
   */
  to?: string | string[]
  /** Hex calldata for generic proposals (parallel to `to`; calls execute in order) */
  calldata?: Hex | Hex[]
  /**
   * When true (default for generic), Safe calls Timelock.scheduleBatch(Diamond, payload).
   * When false, use --direct instead (Safe calls target directly).
   */
  timelock?: boolean
  /** When true with generic mode, Safe → target with calldata (no timelock schedule). */
  direct?: boolean
  privateKey?: string
}

export interface IDiamondRegistrationResult {
  success: boolean
  transactionId?: string
  error?: string
}

/** Resume state for `deploy-safe-tron.ts` (singleton + factory addresses). */
export interface ITronSafeTemp {
  safeSingletonAddress?: string
  safeProxyFactoryAddress?: string
}
