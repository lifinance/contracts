/**
 * Energy estimation for Tron, shared by the chain caller and the Safe executor.
 *
 * Both broadcast through the devkit, which sends `wallet/triggersmartcontract`
 * under a fixed `fee_limit` from the environment. Neither had a pre-flight, so
 * this exists to give both the same one: estimate the call with
 * `triggerconstantcontract`, price the energy, and compare it with the limit the
 * devkit is going to apply.
 *
 * The estimate posts raw calldata rather than the devkit's own
 * `estimateContractCallEnergy`, which takes a human-readable function selector
 * and hardcodes `call_value: 0`. Neither is available here: these call sites
 * hold encoded calldata and no ABI, and a Safe execution can carry value.
 */

import {
  DEFAULT_SAFETY_MARGIN,
  MAX_RETRIES,
  RETRY_DELAY,
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
  buildTronWalletJsonPostHeaders,
  getTronRPCConfig,
  resolveTronWebRpcUrlToFullHost,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout'

/**
 * The devkit's default cap, mirrored so a refusal can name the figure the
 * broadcast will actually run under.
 */
const TRON_DEFAULT_FEE_LIMIT_SUN = 50_000_000

/** The env var the devkit reads for that cap. */
export const TRON_FEE_LIMIT_SUN_ENV = 'TRON_SAFE_EXEC_FEE_LIMIT_SUN'

export interface ITronEnergyEstimateParams {
  networkKey: TronTvmNetworkName
  /** Base58 address the call is made from. */
  ownerBase58: string
  /** Base58 address of the contract being called. */
  contractBase58: string
  /** Calldata, `0x`-prefixed. */
  data: `0x${string}`
  /** TRX carried by the call, in SUN. */
  callValue: bigint
  /** Injected in tests so retries do not sleep. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * An estimate failure, tagged with whether trying again could change it.
 *
 * A transport failure might; a node answering "this call would revert" will
 * not, and retrying it only spends the operator's time before the same refusal.
 */
class TronEstimateError extends Error {
  public constructor(message: string, public readonly retryable: boolean) {
    super(message)
    this.name = 'TronEstimateError'
  }
}

/**
 * Newest energy price at or before now, in SUN, from Tron's
 * `getEnergyPrices` history string (`<ms>:<sunPerEnergy>,...`).
 *
 * @param priceString - The history as the node returns it.
 * @returns Price in SUN per energy.
 * @throws When the string carries no usable price.
 */
export const latestEnergyPriceSun = (priceString: string): number => {
  const now = Date.now()
  const entries = priceString
    .split(',')
    .map((entry) => entry.split(':'))
    .map(([timestamp, price]) => ({
      timestamp: Number(timestamp),
      price: Number(price),
    }))
    .filter(
      ({ timestamp, price }) =>
        Number.isFinite(timestamp) && Number.isFinite(price) && price > 0
    )
    .sort((a, b) => b.timestamp - a.timestamp)

  const applicable = entries.find(({ timestamp }) => timestamp <= now)
  const price = applicable?.price ?? entries[entries.length - 1]?.price

  if (price === undefined)
    throw new Error(
      `No usable energy price in '${priceString}'. Refusing to price a broadcast ` +
        `against a guessed rate.`
    )

  return price
}

/**
 * Reads the fee limit the devkit will apply to the next broadcast.
 *
 * Deliberately mirrors the devkit's own parse, including throwing on a
 * malformed value: a guard that computed a different limit from the one the
 * broadcast runs under would be checking the wrong number.
 *
 * @returns The cap in SUN.
 * @throws When the env var is set to something that is not a positive integer.
 */
export const configuredTronFeeLimitSun = (): number => {
  const raw = process.env[TRON_FEE_LIMIT_SUN_ENV]?.trim()
  if (raw === undefined || raw === '') return TRON_DEFAULT_FEE_LIMIT_SUN

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(
      `${TRON_FEE_LIMIT_SUN_ENV} must be a positive integer (SUN), got: ${raw}`
    )

  return parsed
}

/**
 * Applies the devkit's safety margin to a raw `energy_used` figure.
 *
 * The justification is parity, not measurement. The deploy scripts price calls
 * through the devkit's own `estimateContractEnergy`, which applies this same
 * constant, so without it the deploy path and this guard would disagree about
 * what a call costs. The one measurement this repo has of a real batch
 * (EXSC-842: 501,386 simulated against roughly 501,348 charged) shows
 * `triggerconstantcontract` was accurate to well under a percent and slightly
 * *over*, so the margin should not be described as correcting an under-report.
 * It buys headroom for the state drift between simulating and sending.
 *
 * Separated out so it can be tested: the request around it needs a live
 * endpoint, and this is the arithmetic that decides whether a batch is refused.
 *
 * @param rawEnergyUsed - `energy_used` as `triggerconstantcontract` reports it.
 * @returns The figure the guard should compare, margin included.
 */
export const applyTronSafetyMargin = (rawEnergyUsed: number): bigint =>
  BigInt(Math.ceil(rawEnergyUsed * DEFAULT_SAFETY_MARGIN))

/** One `triggerconstantcontract` round trip. Throws on anything unusable. */
const requestEnergyUsed = async (
  params: ITronEnergyEstimateParams
): Promise<number> => {
  const { rpcUrl } = getTronRPCConfig(params.networkKey)
  const fullHost = resolveTronWebRpcUrlToFullHost(rpcUrl, params.networkKey)
  const apiUrl = fullHost.replace(/\/$/, '') + '/wallet/triggerconstantcontract'

  const res = await fetchWithTimeout(
    apiUrl,
    {
      method: 'POST',
      headers: buildTronWalletJsonPostHeaders(fullHost),
      body: JSON.stringify({
        owner_address: params.ownerBase58,
        contract_address: params.contractBase58,
        data: params.data.slice(2),
        // A high limit for the estimate itself; it caps nothing that broadcasts.
        fee_limit: TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
        call_value: params.callValue > 0n ? Number(params.callValue) : 0,
        visible: true,
      }),
    },
    TRON_WALLET_API_FETCH_TIMEOUT_MS
  )

  if (!res.ok) {
    const text = await res.text()
    throw new TronEstimateError(
      `triggerconstantcontract failed: ${res.status} ${text}`,
      true
    )
  }

  const result = (await res.json()) as {
    energy_used?: number
    result?: { result?: boolean; message?: string }
  }

  if (
    result.result?.result === false ||
    result.energy_used === undefined ||
    result.energy_used === null
  )
    // Deterministic: this is what a call that would revert looks like here, and
    // asking again returns the same answer.
    throw new TronEstimateError(
      `Tron simulation failed: ${JSON.stringify(result.result ?? result)}`,
      false
    )

  // A contract call always burns energy, so a zero is a node answering without
  // having simulated. Priced, it would cost nothing and clear any fee limit —
  // the guard would be a no-op on exactly the batches it exists to stop.
  if (!(result.energy_used > 0))
    throw new TronEstimateError(
      `triggerconstantcontract reported ${result.energy_used} energy, which no ` +
        `contract call costs. Refusing to treat it as an estimate.`,
      false
    )

  return result.energy_used
}

/**
 * Estimates the energy a contract call would consume, with the devkit's safety
 * margin applied.
 *
 * The margin exists for parity with the devkit's own estimator, which the
 * deploy scripts price through — see {@link applyTronSafetyMargin} for why it
 * is not described as correcting an under-report.
 *
 * Retried on a failed request, because the estimate is now mandatory before any
 * Safe or timelock send and `runPendingTimelockTXs.yml` reaches TronGrid with no
 * API key — a single transient 429 would otherwise refuse a production
 * execution.
 *
 * @param params - Owner, contract, calldata and call value.
 * @returns Estimated energy including the safety margin.
 * @throws When the node rejects every attempt, or returns no energy figure —
 * which is what a call that would revert looks like here.
 */
export const estimateTronEnergy = async (
  params: ITronEnergyEstimateParams
): Promise<bigint> => {
  const sleep = params.sleep ?? realSleep
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return applyTronSafetyMargin(await requestEnergyUsed(params))
    } catch (error) {
      lastError = error
      const retryable =
        error instanceof TronEstimateError ? error.retryable : true
      if (!retryable) break
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Prices energy at the network's current rate.
 *
 * Reads `getEnergyPrices` directly rather than through the devkit's
 * `getCurrentPrices`, which catches its own failure and substitutes a constant.
 * Two things made that unusable for a guard. A node that resolves with an empty
 * price string never reaches the catch at all, so the price came back as `0`,
 * the cost as `0`, and any batch cleared any fee limit. And the substituted
 * constant, 210 SUN/energy, is a real Tron price — mainnet's actual rate for
 * roughly eleven months — so no comparison against its value can tell a
 * fallback from a correct read.
 *
 * Rounded up: the figure decides whether a broadcast is refused, and the
 * conservative direction is to refuse slightly early rather than send a call
 * that cannot finish.
 *
 * @param tronWeb - Client used to read the chain's energy price.
 * @param energy - Energy to price.
 * @returns Cost in SUN.
 * @throws When the price cannot be read, or carries no usable value.
 */
export const tronEnergyCostInSun = async (
  tronWeb: { trx: { getEnergyPrices: () => Promise<string> } },
  energy: bigint
): Promise<bigint> => {
  const priceSun = latestEnergyPriceSun(await tronWeb.trx.getEnergyPrices())
  return BigInt(Math.ceil(Number(energy) * priceSun))
}
