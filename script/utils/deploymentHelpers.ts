/**
 * Helpers for loading deployment JSON files from the `deployments/` directory.
 */

import path from 'path'
import { fileURLToPath } from 'url'

import { type SupportedChain, EnvironmentEnum } from '../common/types'

/**
 * Shape of an imported `deployments/<network>[.staging].json` module: contract name →
 * address. The module namespace also carries a `default` export object at runtime.
 */
type DeploymentsFileModule = Record<string, string> & {
  default?: Record<string, string>
}

// In-run memoization so repeated lookups for the same network/environment (e.g.
// per-address labelling in confirm-safe-tx) load each deployments file only once.
const deploymentsCache = new Map<string, Promise<DeploymentsFileModule>>()

/**
 * Utility function to dynamically import the deployments file for a chain.
 * Results are cached per (chain, environment) for the lifetime of the process.
 */
export const getDeployments = async (
  chain: SupportedChain,
  environment: EnvironmentEnum = EnvironmentEnum.staging
) => {
  const cacheKey = `${chain}:${environment}`
  const cached = deploymentsCache.get(cacheKey)
  if (cached) return cached

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const fileName =
    environment === EnvironmentEnum.production
      ? `${chain}.json`
      : `${chain}.staging.json`
  const filePath = path.resolve(__dirname, `../../deployments/${fileName}`)

  const loadPromise: Promise<DeploymentsFileModule> = import(filePath).catch(
    () => {
      // Drop failed loads so a later call can retry instead of caching the rejection
      deploymentsCache.delete(cacheKey)
      throw new Error(
        `Deployments file not found for ${chain} (${environment}): ${filePath}`
      )
    }
  )
  deploymentsCache.set(cacheKey, loadPromise)
  return loadPromise
}
