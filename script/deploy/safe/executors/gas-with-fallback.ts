/**
 * Gas estimation with chain-specific resilience for Safe/timelock execution.
 *
 * Wraps a viem gas estimation with a configurable safety multiplier via
 * `GAS_ESTIMATE_MULTIPLIER` (default 130%, matching Foundry) — needed because
 * viem's default ~20% buffer is too small to cover Safe / timelock post-call
 * overhead on chains with tight simulation-vs-execution deltas (see PR #1762).
 *
 * Every caller must declare what happens when estimation throws:
 * `refuse` for anything that broadcasts, `fallback` only for dry runs.
 */

import { consola } from 'consola'

import {
  DEFAULT_GAS_ESTIMATE_MULTIPLIER_PERCENT,
  DEFAULT_GAS_FALLBACK,
} from '../../shared/constants'

/**
 * `refuse` — reject. The caller is about to broadcast, and a failed estimate
 * usually means the transaction would revert, so a guessed limit burns gas for
 * nothing and can consume a Safe nonce.
 * `fallback` — return a fixed limit. Only for paths that broadcast nothing.
 */
export type GasEstimateFailureMode = 'refuse' | 'fallback'

export interface IGasWithFallbackOptions {
  onEstimateFailure: GasEstimateFailureMode
  fallbackGas?: bigint
  networkName?: string
  /** Named in the refusal so the operator knows which action was stopped. */
  operation?: string
}

const AFFIRMATIVE = new Set(['true', '1', 'yes', 'y', 'on'])

/**
 * Whether the operator deliberately opted into broadcasting on a failed
 * estimate. Only an affirmative value opens it, so a stray empty or negative
 * export cannot silently restore the old broadcast-anyway behaviour.
 */
const fallbackExplicitlyAllowed = (): boolean =>
  AFFIRMATIVE.has(
    (process.env.ALLOW_GAS_ESTIMATE_FALLBACK ?? '').trim().toLowerCase()
  )

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
 * Run a viem gas estimator and return `estimate * multiplier / 100`.
 *
 * @param estimate - async fn returning a viem gas estimate (bigint)
 * @param options - failure mode (required), plus optional fallback limit and labels
 * @returns the gas limit to apply to the subsequent transaction
 * @throws when estimation fails and `onEstimateFailure` is `refuse` without
 * `ALLOW_GAS_ESTIMATE_FALLBACK` set to an affirmative value.
 */
export async function getGasWithFallback(
  estimate: () => Promise<bigint>,
  options: IGasWithFallbackOptions
): Promise<bigint> {
  const multiplier = resolveMultiplier()
  try {
    const estimated = await estimate()
    return (estimated * multiplier) / 100n
  } catch (error) {
    const fallbackGas = options.fallbackGas ?? DEFAULT_GAS_FALLBACK
    const reason = error instanceof Error ? error.message : String(error)
    const where = options.networkName ? ` on ${options.networkName}` : ''
    const what = options.operation ? ` for ${options.operation}` : ''

    if (options.onEstimateFailure === 'refuse' && !fallbackExplicitlyAllowed())
      throw new Error(
        `Gas estimation failed${where}${what} — refusing to broadcast.\n` +
          `  Underlying error: ${reason}\n` +
          `  A failed estimate usually means the transaction would revert, so broadcasting on a ` +
          `guessed limit burns gas for nothing and can consume a Safe nonce.\n` +
          `  Investigate the revert first. To broadcast anyway on a fixed limit of ${fallbackGas}, ` +
          `re-run with ALLOW_GAS_ESTIMATE_FALLBACK=true.`
      )

    if (options.onEstimateFailure === 'refuse')
      consola.warn(
        `Gas estimation failed${where}${what}; ALLOW_GAS_ESTIMATE_FALLBACK is set, so broadcasting ` +
          `on a fixed limit of ${fallbackGas}. Underlying error: ${reason}`
      )
    else
      consola.warn(
        `Gas estimation failed${where}${what}; reporting a fixed limit of ${fallbackGas}. ` +
          `Underlying error: ${reason}`
      )

    return fallbackGas
  }
}
