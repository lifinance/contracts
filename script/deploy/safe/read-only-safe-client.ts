/**
 * Read-only viem clients for Safe contract queries without a signing wallet.
 */

import { createPublicClient, http, type PublicClient } from 'viem'

import {
  getFallbackTransportForChain,
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

/**
 * A read-only client that reads through a network's fallback endpoints.
 *
 * `getViemChainForNetworkName` returns `rpcUrls.default.http` as
 * `[primary, ...ETH_NODE_URI_<N>_FALLBACKS]`; `buildReadOnlyClient` takes only
 * the first. That is the right shape for a caller that wants one named
 * endpoint, and the wrong one for the confirmation walk: its executability gate
 * already reads through the whole list via `getFallbackTransportForChain`, so a
 * dead primary made the preflight refuse a network whose fallbacks were healthy
 * and whose other gates would have read it fine. 75 of the 87 networks that
 * have a primary also declare fallbacks, so that disagreement is the common
 * case rather than the corner.
 *
 * Kept separate from `buildReadOnlyClient` rather than folded into it: that
 * builder is also used by `reconcile.ts` and `safe-utils.ts`, and this change
 * is scoped to the signing walk, where the preflight and the checks it gates
 * have to agree.
 *
 * An explicit `rpcUrl` is the operator naming one endpoint, so it is honoured
 * alone — the fallbacks are configuration this run was told to bypass.
 *
 * @param network - The network to read.
 * @param rpcUrl - An explicit endpoint that replaces the configured list.
 * @returns A client that fails over across the network's declared endpoints.
 */
export function buildFallbackReadClient(
  network: string,
  rpcUrl?: string
): PublicClient {
  if (rpcUrl?.trim()) return buildReadOnlyClient(network, rpcUrl)

  const chain = getViemChainForNetworkName(network)

  return createPublicClient({
    chain,
    transport: getFallbackTransportForChain(chain),
  }) as PublicClient
}
