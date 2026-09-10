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

import { redactErrorReason } from '../../../utils/redactUrls'
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
 * estimate for this network.
 *
 * Accepts an affirmative value for every network, or a comma-separated network
 * list to scope it. The list form matters: the executors run
 * `Promise.all` over every network with pending work, so a bare `true` set
 * because one chain cannot estimate would disable the guard for the whole run.
 *
 * Anything else — unset, empty, `false`, `0`, a number — fails closed, so a
 * stray export cannot silently restore the old broadcast-anyway behaviour.
 *
 * @param networkName - network under consideration; absent means an unscoped
 * caller, which the list form cannot satisfy.
 * @returns whether the fallback is permitted here.
 */
export const fallbackExplicitlyAllowed = (networkName?: string): boolean => {
  const raw = (process.env.ALLOW_GAS_ESTIMATE_FALLBACK ?? '').trim()
  if (raw === '') return false
  if (AFFIRMATIVE.has(raw.toLowerCase())) return true

  const scoped = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)

  return networkName !== undefined && scoped.includes(networkName.toLowerCase())
}

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
 * `ALLOW_GAS_ESTIMATE_FALLBACK` permitting it for this network — see
 * {@link fallbackExplicitlyAllowed}.
 */
export async function getGasWithFallback(
  estimate: () => Promise<bigint>,
  options: IGasWithFallbackOptions
): Promise<bigint> {
  return (await resolveGas(estimate, options)).gas
}

export interface IGasResolution {
  gas: bigint
  /** True when `gas` is a fixed fallback because estimation threw. */
  estimateFailed: boolean
}

/**
 * As {@link getGasWithFallback}, but reports whether the figure is a real
 * estimate or a fallback. Use this where the distinction is visible to an
 * operator — a dry run must not present a fallback as a successful simulation.
 *
 * @param estimate - async fn returning a viem gas estimate (bigint)
 * @param options - failure mode (required), plus optional fallback limit and labels
 * @returns the gas limit and whether it came from a fallback
 * @throws under the same conditions as {@link getGasWithFallback}
 */
export async function resolveGas(
  estimate: () => Promise<bigint>,
  options: IGasWithFallbackOptions
): Promise<IGasResolution> {
  const multiplier = resolveMultiplier()
  try {
    const estimated = await estimate()
    return { gas: (estimated * multiplier) / 100n, estimateFailed: false }
  } catch (error) {
    const fallbackGas = options.fallbackGas ?? DEFAULT_GAS_FALLBACK
    // Redacted before it reaches a terminal, a CI log or Slack: viem embeds the
    // full endpoint in error.message and provider credentials ride in the query
    // string. redactUrls.ts mandates this for anything derived from an error.
    const reason = redactErrorReason(
      error instanceof Error ? error.message : String(error)
    )
    const where = options.networkName ? ` on ${options.networkName}` : ''
    const what = options.operation ? ` for ${options.operation}` : ''

    if (
      options.onEstimateFailure === 'refuse' &&
      !fallbackExplicitlyAllowed(options.networkName)
    )
      throw new Error(
        `Gas estimation failed${where}${what} — refusing to broadcast.\n` +
          `  Underlying error: ${reason}\n` +
          `  A failed estimate usually means the transaction would revert, so broadcasting on a ` +
          `guessed limit burns gas for nothing and can consume a Safe nonce.\n` +
          `  Investigate the revert first. To broadcast anyway on a fixed limit of ${fallbackGas}, ` +
          `re-run with ALLOW_GAS_ESTIMATE_FALLBACK=${
            options.networkName ?? 'true'
          } — scope it to the affected network, because the value "true" disables ` +
          `this guard for every network in the run.`
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

    return { gas: fallbackGas, estimateFailed: true }
  }
}
