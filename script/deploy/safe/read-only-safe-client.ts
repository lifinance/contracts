/**
 * Read-only viem clients for Safe contract queries without a signing wallet.
 */

import { createPublicClient, http, type PublicClient } from 'viem'

import {
  getFallbackTransportForChain,
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'

/**
 * Builds a read-only viem client for a network, honoring an optional RPC
 * override.
 *
 * Without an override the client reads through every endpoint the network has,
 * in priority order — the transport the executability gate already uses. These
 * reads decide whether a network can be signed at all, so reading them through
 * the primary alone made a network with a throttled primary and a healthy spare
 * unusable while the gates read it fine, and a signer cannot act on a network
 * the run disagrees with itself about.
 *
 * `getFallbackTransportForChain` builds each endpoint through
 * `getTransportConfigFromRpcUrl`, which is what keeps a `user:pass@` endpoint
 * authenticated: viem's own branch is `if (url.username)`, so a password-only
 * endpoint would be queried unauthenticated and answer 401.
 *
 * @param network - The network key, as `config/networks.json` spells it.
 * @param rpcUrl - One endpoint to use instead of the configured set.
 * @param options - `signal` bounds every request the client makes, retries
 *   included; without it an endpoint that never answers costs viem's full retry
 *   budget before the caller hears about it.
 * @returns A public client for read calls only.
 */
export function buildReadOnlyClient(
  network: string,
  rpcUrl?: string,
  options?: { signal?: AbortSignal }
): PublicClient {
  const chain = getViemChainForNetworkName(network)

  if (!rpcUrl)
    return createPublicClient({
      chain,
      transport: getFallbackTransportForChain(chain, options),
    }) as PublicClient

  const { url, fetchOptions, retryCount, retryDelay } =
    getTransportConfigFromRpcUrl(rpcUrl)
  const mergedFetchOptions = {
    ...(fetchOptions ?? {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  }

  return createPublicClient({
    chain,
    transport: http(url, {
      ...(Object.keys(mergedFetchOptions).length
        ? { fetchOptions: mergedFetchOptions }
        : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(retryDelay !== undefined ? { retryDelay } : {}),
    }),
  }) as PublicClient
}
