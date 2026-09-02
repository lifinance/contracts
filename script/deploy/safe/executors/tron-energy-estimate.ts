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
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
  buildTronWalletJsonPostHeaders,
  calculateEstimatedCost,
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
 * Estimates the energy a contract call would consume.
 *
 * @param params - Owner, contract, calldata and call value.
 * @returns Estimated energy.
 * @throws When the node rejects the request, or returns no energy figure —
 * which is what a call that would revert looks like here.
 */
export const estimateTronEnergy = async (
  params: ITronEnergyEstimateParams
): Promise<bigint> => {
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

  return BigInt(result.energy_used)
}

/**
 * Prices energy at the network's current rates.
 *
 * Rounded up, because the figure decides whether a broadcast is refused and the
 * conservative direction for that is to refuse slightly early rather than
 * broadcast a call that cannot finish.
 *
 * @param tronWeb - Client used to read the chain's energy price.
 * @param energy - Energy to price.
 * @returns Cost in SUN.
 */
export const tronEnergyCostInSun = async (
  tronWeb: Parameters<typeof calculateEstimatedCost>[0],
  energy: bigint
): Promise<bigint> => {
  const { totalCost } = await calculateEstimatedCost(tronWeb, Number(energy), 0)
  return BigInt(Math.ceil(totalCost * 1_000_000))
}
