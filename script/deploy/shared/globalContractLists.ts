import globalConfig from '../../../config/global.json'

/**
 * Get list of core facets from global config, with optional exclusions.
 */
export function getCoreFacets({
  exclude = [],
}: { exclude?: string[] } = {}): string[] {
  const facets = (globalConfig as any).coreFacets || []
  if (exclude.length === 0) return facets
  return facets.filter((facet: string) => !exclude.includes(facet))
}

/**
 * Get list of core periphery contracts from global config, with optional exclusions.
 */
export function getCorePeriphery({
  exclude = [],
}: { exclude?: string[] } = {}): string[] {
  const periphery = (globalConfig as any).corePeriphery || []
  if (exclude.length === 0) return periphery
  return periphery.filter((contract: string) => !exclude.includes(contract))
}
