import { fetchWithTimeout } from '../../../utils/fetchWithTimeout'
import {
  DEFAULT_SAFETY_MARGIN,
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
} from '../constants'
import type { IEstimateContractCallEnergyParams } from '../types'

import { buildTronWalletJsonPostHeaders } from './tronRpcConfig'

/**
 * Estimate energy for a contract call via TRON triggerconstantcontract API.
 * Returns estimated energy with safety margin applied. Use to set feeLimit so delegated energy is used first.
 */
export async function estimateContractCallEnergy(
  params: IEstimateContractCallEnergyParams
): Promise<number> {
  const {
    fullHost,
    tronWeb,
    contractAddressBase58,
    functionSelector,
    parameterHex,
    safetyMargin = DEFAULT_SAFETY_MARGIN,
    feeLimitForEstimation = TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  } = params
  const apiUrl = fullHost.replace(/\/$/, '') + '/wallet/triggerconstantcontract'
  const ownerAddress =
    typeof tronWeb.defaultAddress.base58 === 'string'
      ? tronWeb.defaultAddress.base58
      : ''
  if (!ownerAddress)
    throw new Error('Deployer address (base58) not available for estimation')
  const payload = {
    owner_address: ownerAddress,
    contract_address: contractAddressBase58,
    function_selector: functionSelector,
    parameter: parameterHex,
    fee_limit: feeLimitForEstimation,
    call_value: 0,
    visible: true,
  }
  let res: Response
  try {
    res = await fetchWithTimeout(
      apiUrl,
      {
        method: 'POST',
        headers: buildTronWalletJsonPostHeaders(fullHost),
        body: JSON.stringify(payload),
      },
      TRON_WALLET_API_FETCH_TIMEOUT_MS
    )
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError')
      throw new Error(
        `triggerconstantcontract timed out after ${TRON_WALLET_API_FETCH_TIMEOUT_MS}ms`
      )
    throw e
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`triggerconstantcontract failed: ${res.status} ${text}`)
  }
  const result = (await res.json()) as {
    energy_used?: number
    result?: { result?: boolean }
  }
  if (
    result.result?.result === false ||
    result.energy_used === undefined ||
    result.energy_used === null
  ) {
    throw new Error(
      `No energy estimate (${functionSelector}): ${JSON.stringify(result)}`
    )
  }
  return Math.ceil(result.energy_used * safetyMargin)
}
