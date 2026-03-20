/**
 * Tron-specific JSON-RPC URL normalization for viem.
 * Kept under deploy/tron/helpers so it stays a leaf module (no import cycle with
 * deploy/tron/utils.ts → demoScriptHelpers → viemScriptHelpers).
 */

import { TRON_NETWORK_KEYS } from '../../shared/constants'

/**
 * TronGrid full-node roots serve Tron's native HTTP API; viem uses JSON-RPC
 * `eth_*` methods at `.../jsonrpc`. POSTs to the root return 405 Not Allowed.
 */
export function tronJsonRpcUrlForViem(
  networkKey: string,
  rpcUrl: string
): string {
  if (!TRON_NETWORK_KEYS.has(networkKey.toLowerCase())) return rpcUrl
  const base = rpcUrl.replace(/\/+$/, '')
  if (base.endsWith('/jsonrpc')) return base
  return `${base}/jsonrpc`
}

/**
 * TronWeb `fullHost` expects the native full-node root URL, not the JSON-RPC
 * `.../jsonrpc` path used by viem. Inverse of {@link tronJsonRpcUrlForViem}.
 */
export function tronWebFullHostFromRpcUrl(
  networkKey: string,
  rpcUrl: string
): string {
  if (!TRON_NETWORK_KEYS.has(networkKey.toLowerCase())) {
    return rpcUrl.replace(/\/+$/, '')
  }
  const base = rpcUrl.replace(/\/+$/, '')
  const jsonrpcSuffix = '/jsonrpc'
  if (base.toLowerCase().endsWith(jsonrpcSuffix)) {
    return base.slice(0, -jsonrpcSuffix.length)
  }
  return base
}
