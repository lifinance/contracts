import { DEFAULT_SAFETY_MARGIN } from '../constants'
import type { IEstimateContractCallEnergyParams } from '../types'

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
    feeLimitForEstimation = 1_000_000_000,
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
    parameter: parameterHex.replace(/^0x/i, ''),
    fee_limit: feeLimitForEstimation,
    call_value: 0,
    visible: true,
  }
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`triggerconstantcontract failed: ${res.status} ${text}`)
  }
  const result = (await res.json()) as {
    energy_used?: number
    result?: { result?: boolean }
  }
  if (result.result?.result === false || !result.energy_used) {
    throw new Error(
      `No energy estimate (${functionSelector}): ${JSON.stringify(result)}`
    )
  }
  return Math.ceil(result.energy_used * safetyMargin)
}
