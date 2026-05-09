/**
 * Gas estimation with chain-specific resilience for Safe/timelock execution.
 *
 * Wraps a viem gas estimation with: (1) a configurable safety multiplier via
 * `GAS_ESTIMATE_MULTIPLIER` env var (default 130%, matching Foundry), and
 * (2) a fixed fallback when estimation throws. Required for chains like Jovay
 * where `eth_estimateGas` can revert even when `eth_call` with unlimited gas
 * succeeds, and where viem's default ~20% buffer is too small to cover Safe /
 * timelock post-call overhead. See PR #1762.
 */

import { consola } from 'consola'

import {
  DEFAULT_GAS_ESTIMATE_MULTIPLIER_PERCENT,
  DEFAULT_GAS_FALLBACK,
} from '../../shared/constants'

/**
 * Resolve `GAS_ESTIMATE_MULTIPLIER` from env, defaulting to
 * {@link DEFAULT_GAS_ESTIMATE_MULTIPLIER_PERCENT}. Empty / whitespace /
 * non-numeric / non-positive values fall back to default.
 */
function resolveMultiplier(): bigint {
  const raw = process.env.GAS_ESTIMATE_MULTIPLIER?.trim()
  if (!raw) return DEFAULT_GAS_ESTIMATE_MULTIPLIER_PERCENT
  try {
    const parsed = BigInt(raw)
    return parsed > 0n ? parsed : DEFAULT_GAS_ESTIMATE_MULTIPLIER_PERCENT
  } catch {
    return DEFAULT_GAS_ESTIMATE_MULTIPLIER_PERCENT
  }
}

/**
 * Run a viem gas estimator and return either `(estimate * multiplier / 100)` or
 * a fallback gas limit if estimation throws. Logs a warning on fallback so the
 * caller knows a fixed limit was used.
 *
 * @param estimate - async fn returning a viem gas estimate (bigint)
 * @param fallbackGas - gas limit used when estimation throws (default {@link DEFAULT_GAS_FALLBACK})
 * @returns gas limit to apply to the subsequent transaction
 */
export async function getGasWithFallback(
  estimate: () => Promise<bigint>,
  fallbackGas: bigint = DEFAULT_GAS_FALLBACK
): Promise<bigint> {
  const multiplier = resolveMultiplier()
  try {
    const estimated = await estimate()
    return (estimated * multiplier) / 100n
  } catch {
    consola.warn(
      `Gas estimation failed; using fallback gas limit: ${fallbackGas}`
    )
    return fallbackGas
  }
}
