/**
 * Read-only viem clients for Safe contract queries without a signing wallet.
 */

import { createPublicClient, http, type PublicClient } from 'viem'

import {
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'

/** Builds a read-only viem client for a network, honoring an optional RPC override. */
export function buildReadOnlyClient(
  network: string,
  rpcUrl?: string
): PublicClient {
  const chain = getViemChainForNetworkName(network)
  // viem lifts `user:pass@` out of a URL itself, but its branch is
  // `if (url.username)`, so a password-only endpoint is queried unauthenticated
  // and answers 401. This client decides whether a network has actionable
  // transactions at all, so that 401 drops the network silently rather than
  // surfacing as a failed read.
  const endpointUrl = rpcUrl ?? chain.rpcUrls.default.http[0]
  const { url, fetchOptions, retryCount, retryDelay } = endpointUrl
    ? getTransportConfigFromRpcUrl(endpointUrl)
    : {
        url: undefined,
        fetchOptions: undefined,
        retryCount: undefined,
        retryDelay: undefined,
      }

  return createPublicClient({
    chain,
    transport: http(url, {
      ...(fetchOptions ? { fetchOptions } : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(retryDelay !== undefined ? { retryDelay } : {}),
    }),
  }) as PublicClient
}
