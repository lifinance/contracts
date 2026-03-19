import globalConfig from '../../../../config/global.json'

/**
 * Get list of core facets from global config
 */
export function getCoreFacets(): string[] {
  const facets = (globalConfig as any).coreFacets || []
  // Filter out GasZipFacet for TRON deployment
  return facets.filter((facet: string) => facet !== 'GasZipFacet')
}

/**
 * Get list of core periphery contracts for Tron deployment
 * Filters out contracts that are not deployed on Tron
 */
export function getTronCorePeriphery(): string[] {
  const periphery = (globalConfig as any).corePeriphery || []
  // Filter out contracts not deployed on Tron
  return periphery.filter(
    (contract: string) =>
      contract !== 'GasZipPeriphery' && // Not deployed on Tron
      contract !== 'LiFiDEXAggregator' && // Not deployed on Tron
      contract !== 'Permit2Proxy' // Not deployed on Tron
  )
}
