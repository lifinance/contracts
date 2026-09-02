/**
 * Pre-flight for anything that broadcasts on Tron.
 *
 * The EVM Safe and timelock paths refuse to broadcast when gas estimation fails
 * (`gas-with-fallback.ts`). Tron had no pre-flight at all: the devkit caps every
 * transaction at a fixed `fee_limit` read from the environment, signs, and sends.
 *
 * So Tron needs the EVM rule and one more. A fee limit that cannot pay for the
 * transaction does not make it fail cleanly — it runs until the energy is spent
 * and aborts part-way through, which for a multi-call timelock batch means an
 * operation that is neither applied nor abandoned, and a workflow that retries
 * it forever. That is worth refusing before the send, not diagnosing after it.
 *
 * The escape hatch is deliberately the same `ALLOW_GAS_ESTIMATE_FALLBACK` the
 * EVM paths read, so an operator has one switch to learn and one to audit.
 */

import { consola } from 'consola'

import type { IChainSimulateResult } from '../../../common/types'
import { redactErrorReason } from '../../../utils/redactUrls'

import { fallbackExplicitlyAllowed } from './gas-with-fallback'
/** The env var the devkit reads for its cap, named in refusals so it can be raised. */
export const TRON_FEE_LIMIT_ENV = 'TRON_SAFE_EXEC_FEE_LIMIT_SUN'

export interface ITronEnergyPreflightOptions {
  /** Network under consideration; scopes the escape hatch and names the refusal. */
  networkName: string
  /** Named in the refusal so the operator knows which action was stopped. */
  operation: string
  /** SUN the devkit will cap this transaction at. */
  feeLimitSun: number
  /** Cost of that much energy at the chain's current rate. Throws if unreadable. */
  costInSun: (energy: bigint) => Promise<bigint>
}

export interface ITronEnergyPreflightResult {
  estimatedEnergy: bigint
  /** Cost of {@link estimatedEnergy} in SUN; 0n when there is no estimate. */
  costSun: bigint
  /** True when the caller is proceeding without a real estimate. */
  estimateFailed: boolean
}

const escapeHatchNote = (networkName: string): string =>
  `To broadcast anyway, re-run with ALLOW_GAS_ESTIMATE_FALLBACK=${networkName} — ` +
  `scope it to the affected network, because the value "true" disables this guard ` +
  `for every network in the run.`

/**
 * Estimate first, then decide whether broadcasting is allowed.
 *
 * @param estimate - Runs the energy estimate. Throwing and returning
 * `estimateFailed: true` are treated alike: neither is an estimate. No Tron
 * estimator returns the latter today — `TronChainCaller.simulate` throws
 * instead — so that arm exists so a future estimator that reports a fallback
 * figure cannot make this guard read it as a real one.
 * @param options - Network and operation labels, the configured fee limit, and
 * the energy-to-SUN conversion.
 * @returns The estimate and its cost.
 * @throws When there is no usable estimate, or the estimate costs more than the
 * configured fee limit, and {@link fallbackExplicitlyAllowed} does not permit it
 * for this network.
 */
export const assertTronBroadcastAffordable = async (
  estimate: () => Promise<IChainSimulateResult>,
  options: ITronEnergyPreflightOptions
): Promise<ITronEnergyPreflightResult> => {
  const { networkName, operation, feeLimitSun } = options
  const where = `on ${networkName}`
  const what = `for ${operation}`

  let simulated: IChainSimulateResult | undefined
  let failure: string | undefined

  try {
    const result = await estimate()
    if (result.estimateFailed)
      failure = 'the estimate returned a fixed fallback rather than a figure'
    else simulated = result
  } catch (error) {
    // Redacted before it reaches a terminal, a CI log or Slack: the endpoint is
    // embedded in these errors and provider credentials ride in its query
    // string. redactUrls.ts mandates this for anything derived from an error.
    failure = redactErrorReason(
      error instanceof Error ? error.message : String(error)
    )
  }

  if (simulated === undefined) {
    if (!fallbackExplicitlyAllowed(networkName))
      throw new Error(
        `Energy estimation failed ${where} ${what} — refusing to broadcast.\n` +
          `  Underlying error: ${failure}\n` +
          `  A failed estimate usually means the transaction would revert, and Tron ` +
          `charges for a reverted call, so broadcasting on the fixed fee limit burns ` +
          `energy for nothing.\n` +
          `  Investigate the revert first. ${escapeHatchNote(networkName)}`
      )

    consola.warn(
      `Energy estimation failed ${where} ${what}; ALLOW_GAS_ESTIMATE_FALLBACK is set, ` +
        `so broadcasting on the fee limit of ${feeLimitSun} SUN. Underlying error: ${failure}`
    )
    return { estimatedEnergy: 0n, costSun: 0n, estimateFailed: true }
  }

  const estimatedEnergy = simulated.estimatedResource

  let costSun: bigint
  try {
    costSun = await options.costInSun(estimatedEnergy)
  } catch (error) {
    // Inside the redaction boundary for the same reason as the estimate above:
    // the endpoint is embedded in these errors and provider credentials ride in
    // its query string.
    throw new Error(
      `Could not price ${estimatedEnergy} energy ${where} ${what} — refusing to broadcast.\n` +
        `  Underlying error: ${redactErrorReason(
          error instanceof Error ? error.message : String(error)
        )}\n` +
        `  Without a price there is no way to tell whether the fee limit covers this call. ` +
        `${escapeHatchNote(networkName)}`
    )
  }

  if (costSun > BigInt(feeLimitSun)) {
    if (!fallbackExplicitlyAllowed(networkName))
      throw new Error(
        `Estimated energy exceeds the fee limit ${where} ${what} — refusing to broadcast.\n` +
          `  Estimated ${estimatedEnergy} energy, costing ${costSun} SUN, against a fee ` +
          `limit of ${feeLimitSun} SUN.\n` +
          `  Broadcasting would not fail cleanly: the call runs until the limit is spent ` +
          `and aborts part-way, leaving the operation neither applied nor abandoned while ` +
          `the energy is still charged.\n` +
          `  Raise ${TRON_FEE_LIMIT_ENV} to at least ${costSun}, or split the batch. ` +
          `${escapeHatchNote(networkName)}`
      )

    consola.warn(
      `Estimated ${estimatedEnergy} energy costs ${costSun} SUN, above the fee limit of ` +
        `${feeLimitSun} SUN ${where} ${what}; ALLOW_GAS_ESTIMATE_FALLBACK is set, so ` +
        `broadcasting anyway. It may abort part-way through.`
    )
  }

  return { estimatedEnergy, costSun, estimateFailed: false }
}
