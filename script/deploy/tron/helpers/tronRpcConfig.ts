import { consola } from 'consola'

import { getEnvVar, getRPCEnvVarName } from '../../../utils/utils'
import { TRON_PRO_API_KEY_HEADER } from '../constants'

import { isTronGridRpcUrl } from './isTronGridRpcUrl'

/**
 * Get TronGrid API key from environment variables.
 *
 * Official Tron RPC (TronGrid) requires the API key to be sent in HTTP headers
 * (specifically as 'TRON-PRO-API-KEY' header), NOT in the URI/URL itself.
 *
 * This function checks for the TRONGRID_API_KEY environment variable.
 *
 * @param verbose Whether to log debug information about API key source
 * @returns The API key string, or undefined if not set
 */
export function getTronGridAPIKey(verbose = false): string | undefined {
  const envVarName = 'TRONGRID_API_KEY'

  // First try using getEnvVar (which handles .env files properly)
  try {
    const apiKey = getEnvVar(envVarName)
    if (apiKey && apiKey.trim() !== '') {
      if (verbose)
        consola.debug(
          `Using TronGrid API key from environment variable: ${envVarName}`
        )
      return apiKey.trim()
    }
  } catch {
    // Continue to check process.env directly
  }

  // Also check process.env directly
  const apiKey = process.env[envVarName]
  if (apiKey && apiKey.trim() !== '') {
    if (verbose)
      consola.debug(`Using TronGrid API key from process.env: ${envVarName}`)
    return apiKey.trim()
  }

  if (verbose)
    consola.debug('TronGrid API key not found in environment variables')

  return undefined
}

/**
 * JSON POST headers for Tron `wallet/*` HTTP APIs when using {@link fetchWithTimeout} outside TronWeb.
 * Merges TronGrid `TRON-PRO-API-KEY` when `fullHost` targets TronGrid (same rules as TronWeb config).
 */
export function buildTronWalletJsonPostHeaders(
  fullHost: string,
  verbose = false
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  if (isTronGridRpcUrl(fullHost)) {
    const apiKey = getTronGridAPIKey(verbose)
    if (apiKey) headers[TRON_PRO_API_KEY_HEADER] = apiKey
    else if (verbose) {
      consola.warn(
        '⚠️  Using TronGrid RPC but no API key found. ' +
          'Set TRONGRID_API_KEY in .env to avoid rate limiting.'
      )
    }
  }
  return headers
}

/**
 * Get Tron RPC URL and API key configuration.
 *
 * RPC URLs are sourced only from environment variables (see {@link getRPCEnvVarName}),
 * e.g. `ETH_NODE_URI_TRON`, `ETH_NODE_URI_TRONSHASTA`. There is no fallback to
 * `networks.json` so privileged scripts cannot silently switch nodes.
 *
 * If the RPC URL is TronGrid (official api.*.trongrid.io host), it automatically retrieves
 * the API key from environment variables and includes it in the headers.
 *
 * The API key is sent in HTTP headers as 'TRON-PRO-API-KEY', NOT in the URI/URL itself.
 *
 * @param networkName The network name (e.g., 'tron', 'tronshasta')
 * @param verbose Whether to log debug information about RPC URL and API key source
 * @returns Object containing rpcUrl and headers (with API key if using TronGrid)
 * @throws Error if the RPC env var is missing or the URL is empty/whitespace
 */
export function getTronRPCConfig(
  networkName: string,
  verbose = false
): { rpcUrl: string; headers?: Record<string, string> } {
  const envVarName = getRPCEnvVarName(networkName)
  const rpcUrl = getEnvVar(envVarName).trim()
  if (verbose)
    consola.debug(`Using RPC URL from environment variable: ${envVarName}`)

  if (rpcUrl === '') {
    throw new Error(
      `RPC URL is empty for network: ${networkName} (env: ${envVarName})`
    )
  }

  // Check if using TronGrid and automatically get API key
  const isTronGrid = isTronGridRpcUrl(rpcUrl)
  let headers: Record<string, string> | undefined

  if (isTronGrid) {
    const apiKey = getTronGridAPIKey(verbose)
    if (apiKey) {
      headers = { [TRON_PRO_API_KEY_HEADER]: apiKey }
      if (verbose)
        consola.debug(
          `TronGrid API key will be set as header: ${TRON_PRO_API_KEY_HEADER}`
        )
    } else if (verbose) {
      consola.warn(
        '⚠️  Using TronGrid RPC but no API key found. ' +
          'Set TRONGRID_API_KEY in .env to avoid rate limiting.'
      )
    }
  }

  return { rpcUrl, headers }
}
