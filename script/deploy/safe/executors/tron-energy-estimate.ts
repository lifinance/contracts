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
  FALLBACK_ENERGY_PRICE_TRX,
  MAX_RETRIES,
  RETRY_DELAY,
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
  buildTronWalletJsonPostHeaders,
  getCurrentPrices,
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

const SUN_PER_TRX = 1_000_000

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

export interface ITronEnergyCost {
  costSun: bigint
  /**
   * False when the chain's energy price could not be read and the devkit
   * substituted its constant, so `costSun` is an unconfirmed upper bound.
   */
  priceConfirmed: boolean
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

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
    throw new Error(`triggerconstantcontract failed: ${res.status} ${text}`)
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
    throw new Error(
      `Tron simulation failed: ${JSON.stringify(result.result ?? result)}`
    )

  return result.energy_used
}

/**
 * Estimates the energy a contract call would consume, with the devkit's safety
 * margin applied.
 *
 * The margin is not padding. `triggerconstantcontract` under-reports what the
 * broadcast is charged — the dynamic-energy penalty is not applied to constant
 * calls, and state moves between the estimate and the send — so a batch whose
 * true cost sits just above the raw figure would clear the guard and still
 * abort part-way, which is the failure this pre-flight exists to prevent. The
 * devkit's own estimator applies the same constant, so the deploy scripts and
 * this guard agree on what a call costs.
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
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Prices energy at the network's current rates.
 *
 * Rounded up, because the figure decides whether a broadcast is refused and the
 * conservative direction for that is to refuse slightly early rather than
 * broadcast a call that cannot finish.
 *
 * Reports whether the price was actually read. `getCurrentPrices` swallows its
 * own failure and substitutes a constant more than twice the live mainnet rate,
 * which would refuse honest traffic while quoting an inflated figure to raise
 * the limit to. The caller needs to be able to say the number is unconfirmed.
 *
 * @param tronWeb - Client used to read the chain's energy price.
 * @param energy - Energy to price.
 * @returns Cost in SUN, and whether the price behind it was confirmed.
 */
export const tronEnergyCostInSun = async (
  tronWeb: Parameters<typeof getCurrentPrices>[0],
  energy: bigint
): Promise<ITronEnergyCost> => {
  const { energyPrice } = await getCurrentPrices(tronWeb)

  return {
    costSun: BigInt(Math.ceil(Number(energy) * energyPrice * SUN_PER_TRX)),
    priceConfirmed: energyPrice !== FALLBACK_ENERGY_PRICE_TRX,
  }
}
