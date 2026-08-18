/**
 * Read-only viem clients for Safe contract queries without a signing wallet.
 */

import { createPublicClient, http, type PublicClient } from 'viem'

import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

/** Builds a read-only viem client for a network, honoring an optional RPC override. */
export function buildReadOnlyClient(
  network: string,
  rpcUrl?: string
): PublicClient {
  return createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(rpcUrl),
  }) as PublicClient
}
