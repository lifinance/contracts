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
 * Resolves the on-disk path of a chain's deployments file.
 *
 * Callers that must tell "this chain was never deployed" apart from "the file is
 * there but unreadable" need this: `getDeployments` reports both as not-found.
 *
 * @param chain - Chain the deployments file belongs to.
 * @param environment - Production or staging. Required rather than defaulted:
 * an omitted argument would silently answer for the wrong environment.
 * @returns Absolute path to the deployments file (which may not exist).
 * @throws When `chain` resolves outside `deployments/`.
 */
export const getDeploymentsFilePath = (
  chain: SupportedChain,
  environment: EnvironmentEnum
): string => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const base = path.resolve(__dirname, '../../deployments')
  const fileName =
    environment === EnvironmentEnum.production
      ? `${chain}.json`
      : `${chain}.staging.json`
  const filePath = path.resolve(base, fileName)
  const relativePath = path.relative(base, filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath))
    throw new Error(`Invalid network name: ${chain}`)
  return filePath
}

/**
 * Utility function to dynamically import the deployments file for a chain.
 * Results are cached per (chain, environment) for the lifetime of the process.
 */
export const getDeployments = async (
  chain: SupportedChain,
  environment: EnvironmentEnum = EnvironmentEnum.staging
): Promise<DeploymentsFileModule> => {
  const cacheKey = `${chain}:${environment}`
  const cached = deploymentsCache.get(cacheKey)
  if (cached) return cached

  const filePath = getDeploymentsFilePath(chain, environment)

  const loadPromise: Promise<DeploymentsFileModule> = import(filePath).catch(
    (err: unknown) => {
      // Drop failed loads so a later call can retry instead of caching the rejection
      deploymentsCache.delete(cacheKey)
      // A missing file and an unparseable one both land here; keep the cause so
      // callers that must tell them apart are not left re-deriving it.
      throw new Error(
        `Deployments file not found for ${chain} (${environment}): ${filePath}`,
        { cause: err }
      )
    }
  )
  deploymentsCache.set(cacheKey, loadPromise)
  return loadPromise
}
