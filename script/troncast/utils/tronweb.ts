/**
 * TronWeb initialization and low-level Tron utilities for troncast scripts.
 * Use `initTronWeb` to obtain a TronWeb instance configured for the given environment.
 */

/* eslint-disable import/first */
// Fix for TronWeb proto initialization issue
// This must happen before importing TronWeb
declare global {
  // eslint-disable-next-line no-var
  var proto: Record<string, unknown>
}

if (
  typeof globalThis !== 'undefined' &&
  typeof globalThis.proto === 'undefined'
)
  globalThis.proto = {}

import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'
import { sleep } from '../../utils/delay'
import { getRPCEnvVarName } from '../../utils/utils'
import type { Environment } from '../types'
/* eslint-enable import/first */

/**
 * Creates a TronWeb instance for the given environment.
 * If no `privateKey` is supplied the instance is read-only (a burn address is set so TronWeb
 * doesn't reject view calls that require a default address).
 *
 * @param env - `'mainnet'` maps to the `tron` network key; anything else maps to `tronshasta`.
 * @param privateKey - Optional signing key (hex). Omit for read-only access.
 * @param rpcUrl - Optional RPC override; defaults to `ETH_NODE_URI_<NETWORK>` env var.
 * @returns Configured TronWeb instance.
 */
export function initTronWeb(
  env: Environment,
  privateKey?: string,
  rpcUrl?: string
): TronWeb {
  // Get RPC URL from environment variables using repo helpers if not provided
  if (!rpcUrl) {
    const networkName = env === 'mainnet' ? 'tron' : 'tronshasta'
    const envVarName = getRPCEnvVarName(networkName)
    rpcUrl = getEnvVar(envVarName)
  }

  consola.debug(`Initializing TronWeb with ${env} network: ${rpcUrl}`)

  const tronWeb = new TronWeb({
    fullHost: rpcUrl,
    privateKey: privateKey || undefined,
  })

  // TronWeb requires an address to be set even for read-only calls
  // This is a dummy address that won't be used for signing
  if (!privateKey)
    // Using a burn address (all zeros in base58 format)
    tronWeb.setAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')

  return tronWeb
}

/**
 * Parses a human-readable Tron value string to SUN (the smallest Tron unit).
 * Accepts `"<n>tron"` (converts TRX → SUN), `"<n>sun"` (strips suffix), or a bare integer string.
 *
 * @param value - Value string, e.g. `"0.1tron"`, `"100sun"`, or `"1000000"`.
 * @returns The value in SUN as a string.
 */
export function parseValue(value: string): string {
  // Handle formats like "0.1tron", "100sun", "1000000"
  if (value.endsWith('tron')) {
    const amount = parseFloat(value.replace('tron', ''))
    return (amount * 1_000_000).toString() // Convert to SUN
  } else if (value.endsWith('sun')) return value.replace('sun', '')

  return value // Assume it's already in SUN
}

/**
 * Polls `getTransactionInfo` until the transaction is confirmed or the timeout expires.
 *
 * @param tronWeb - TronWeb instance to use for polling.
 * @param txId - Transaction ID returned by the broadcast call.
 * @param timeout - Maximum wait time in ms (default: 60 000 ms / 1 minute).
 * @returns The transaction receipt object from Tron.
 * @throws If the transaction is not confirmed within `timeout` ms.
 */
export async function waitForConfirmation(
  tronWeb: TronWeb,
  txId: string,
  timeout = 60000
): Promise<unknown> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      const receipt = await tronWeb.trx.getTransactionInfo(txId)
      if (receipt && receipt.id) return receipt
    } catch (error) {
      // Transaction not yet confirmed
    }
    await sleep(2000)
  }

  throw new Error(`Transaction ${txId} not confirmed within ${timeout}ms`)
}
