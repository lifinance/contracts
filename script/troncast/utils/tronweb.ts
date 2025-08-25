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

import type { Environment } from '../types'
/* eslint-enable import/first */

export function initTronWeb(env: Environment, privateKey?: string): TronWeb {
  // Get RPC URL from environment variables
  let rpcUrl: string

  if (env === 'mainnet') {
    // For mainnet, use ETH_NODE_URI_TRON environment variable
    rpcUrl = process.env.ETH_NODE_URI_TRON || ''
    if (!rpcUrl) 
      throw new Error('ETH_NODE_URI_TRON environment variable is not set')
    
  } else {
    // For testnet, use ETH_NODE_URI_TRONSHASTA environment variable
    rpcUrl = process.env.ETH_NODE_URI_TRONSHASTA || ''
    if (!rpcUrl) 
      throw new Error('ETH_NODE_URI_TRONSHASTA environment variable is not set')
    
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

export function parseValue(value: string): string {
  // Handle formats like "0.1tron", "100sun", "1000000"
  if (value.endsWith('tron')) {
    const amount = parseFloat(value.replace('tron', ''))
    return (amount * 1_000_000).toString() // Convert to SUN
  } else if (value.endsWith('sun')) return value.replace('sun', '')

  return value // Assume it's already in SUN
}

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
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  throw new Error(`Transaction ${txId} not confirmed within ${timeout}ms`)
}
