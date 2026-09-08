/**
 * The seam a direct-EOA Tron broadcast goes through: estimate, price, compare
 * with the fee limit, and only then broadcast. Import it instead of calling
 * `.send()` on a contract wrapper.
 *
 * The broadcast is a callback rather than a statement the guard sits in front
 * of, so a call site holds no bare `.send()` to reorder and the guard cannot be
 * wired in on the wrong side of it.
 */

import { consola } from 'consola'

import {
  applyTronSafetyMargin,
  retryTronEstimate,
  TronEstimateError,
} from './tron-energy-estimate'
import { assertTronBroadcastAffordable } from './tron-energy-preflight'

/** Just the slice of TronWeb the estimate needs, so tests can supply it. */
export interface ITronConstantContractCaller {
  transactionBuilder: {
    triggerConstantContract: (
      contractAddress: string,
      functionSelector: string,
      options: Record<string, unknown>,
      parameters: { type: string; value: unknown }[]
    ) => Promise<{
      energy_used?: number
      result?: { result?: boolean; message?: string }
    }>
  }
}

export interface ITronSelectorEstimateParams {
  tronWeb: ITronConstantContractCaller
  /** Base58 address of the contract being called. */
  contractAddress: string
  /** Human-readable selector, e.g. `transferOwnership(address)`. */
  functionSelector: string
  /** Arguments in TronWeb's `{ type, value }` form. */
  parameters: { type: string; value: unknown }[]
  /** TRX carried by the call, in SUN. */
  callValueSun?: bigint
  /** Injected in tests so retries do not sleep. */
  sleep?: (ms: number) => Promise<void>
}

export interface ITronGuardedSendOptions<T> {
  /** Network under consideration; scopes the escape hatch and names the refusal. */
  networkName: string
  /** Named in the refusal so the operator knows which action was stopped. */
  operation: string
  /** SUN this transaction will be capped at. */
  feeLimitSun: number
  estimateEnergy: () => Promise<bigint>
  costInSun: (energy: bigint) => Promise<bigint>
  /** How to raise the cap on this path, for the refusal message. */
  raiseFeeLimitHint?: (requiredSun: bigint) => string
  /** Runs only once the pre-flight has passed. */
  broadcast: () => Promise<T>
}

/**
 * Estimates energy for a call expressed as a selector plus arguments.
 *
 * Goes through the passed TronWeb rather than `estimateTronEnergy`, which posts
 * raw calldata: these call sites hold decoded arguments and hand the same ones
 * to the contract wrapper that broadcasts, so estimating from them is what
 * prices the call that will actually be sent.
 *
 * A failed round trip is retried through {@link retryTronEstimate}: the estimate
 * is mandatory before the send, so a transient node failure would otherwise
 * refuse a call the operator can afford.
 *
 * @param params - Contract, selector, arguments and call value.
 * @returns Estimated energy with the devkit's safety margin applied.
 * @throws When the node reports no energy figure, which is what a call that
 * would revert looks like here.
 */
export const estimateTronEnergyBySelector = async (
  params: ITronSelectorEstimateParams
): Promise<bigint> => {
  const callValueSun = params.callValueSun ?? 0n
  if (callValueSun > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(
      `callValue ${callValueSun} SUN exceeds Number.MAX_SAFE_INTEGER; ` +
        `estimating it would silently simulate a different, rounded value.`
    )

  return retryTronEstimate(async () => {
    const result =
      await params.tronWeb.transactionBuilder.triggerConstantContract(
        params.contractAddress,
        params.functionSelector,
        { callValue: Number(callValueSun) },
        params.parameters
      )

    if (
      result.result?.result === false ||
      result.energy_used === undefined ||
      result.energy_used === null
    )
      // Deterministic: asking a second time returns the same refusal.
      throw new TronEstimateError(
        `Tron simulation failed for ${params.functionSelector}: ` +
          `${JSON.stringify(result.result ?? result)}`,
        false
      )

    return applyTronSafetyMargin(result.energy_used)
  }, params.sleep)
}

/**
 * Pre-flights the fee limit, then broadcasts.
 *
 * @param options - Labels for the refusal, the cap the send will run under, the
 * estimate and pricing seams, and the broadcast itself.
 * @returns Whatever `broadcast` resolves to.
 * @throws Before broadcasting, when there is no usable estimate or the estimate
 * costs more than the fee limit and `ALLOW_GAS_ESTIMATE_FALLBACK` does not
 * permit it for this network.
 */
export const sendGuardedTronContractCall = async <T>(
  options: ITronGuardedSendOptions<T>
): Promise<T> => {
  const { costSun, estimateFailed } = await assertTronBroadcastAffordable(
    async () => ({
      estimatedResource: await options.estimateEnergy(),
      resourceLabel: 'energy',
      estimateFailed: false,
    }),
    {
      networkName: options.networkName,
      operation: options.operation,
      feeLimitSun: options.feeLimitSun,
      costInSun: options.costInSun,
      raiseFeeLimitHint: options.raiseFeeLimitHint,
    }
  )

  if (!estimateFailed)
    consola.info(
      `Energy pre-flight for ${options.operation} on ${options.networkName}: ` +
        `${costSun} SUN against a fee limit of ${options.feeLimitSun} SUN.`
    )

  return options.broadcast()
}
