import { getCorePeriphery } from '../../shared/globalContractLists'

const TRON_PERIPHERY_EXCLUSIONS = [
  'GasZipPeriphery', // Not deployed on Tron
  'LiFiDEXAggregator', // Not deployed on Tron
  'Permit2Proxy', // Not deployed on Tron
]

/**
 * Get list of core periphery contracts for Tron deployment.
 * Filters out contracts that are not deployed on Tron.
 */
export function getTronCorePeriphery(): string[] {
  return getCorePeriphery({ exclude: TRON_PERIPHERY_EXCLUSIONS })
}
