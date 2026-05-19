/**
 * Tron-specific URL helpers for TronWeb.
 * Kept under deploy/tron/helpers so it stays a leaf module (no import cycle with
 * deploy/tron/utils.ts → demoScriptHelpers → viemScriptHelpers).
 */

import { isTronNetworkKey } from '../../shared/tron-network-keys'

/**
 * TronWeb `fullHost` expects the native full-node root URL, not the JSON-RPC
 * `.../jsonrpc` path used by viem.
 */
export function tronWebFullHostFromRpcUrl(
  networkKey: string,
  rpcUrl: string
): string {
  if (!isTronNetworkKey(networkKey)) {
    return rpcUrl.replace(/\/+$/, '')
  }
  const base = rpcUrl.replace(/\/+$/, '')
  const jsonrpcSuffix = '/jsonrpc'
  if (base.toLowerCase().endsWith(jsonrpcSuffix)) {
    return base.slice(0, -jsonrpcSuffix.length)
  }
  return base
}
