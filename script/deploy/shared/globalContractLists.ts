import type { TronWeb } from 'tronweb'

import globalConfig from '../../../config/global.json'
import type { TTronWalletName } from '../../common/types'

/**
 * Get list of core facets from global config, with optional exclusions.
 */
export function getCoreFacets({
  exclude = [],
}: { exclude?: string[] } = {}): string[] {
  const facets = globalConfig.coreFacets || []
  if (exclude.length === 0) return facets
  return facets.filter((facet: string) => !exclude.includes(facet))
}

/**
 * Get list of core periphery contracts from global config, with optional exclusions.
 */
export function getCorePeriphery({
  exclude = [],
}: { exclude?: string[] } = {}): string[] {
  const periphery = globalConfig.corePeriphery || []
  if (exclude.length === 0) return periphery
  return periphery.filter((contract: string) => !exclude.includes(contract))
}

/**
 * Get a Tron wallet address from `config/global.json` → `tronWallets` only.
 */
export function getTronWallet(
  walletName: TTronWalletName,
  { tronWeb }: { tronWeb: TronWeb }
): string {
  const tronValue = globalConfig.tronWallets[walletName]
  if (typeof tronValue !== 'string')
    throw new Error(
      `Tron wallet '${walletName}' not found in config.tronWallets`
    )

  if (!tronWeb.isAddress(tronValue))
    throw new Error(
      `Invalid Tron address in config.tronWallets['${walletName}']: ${tronValue}`
    )

  return tronValue
}
