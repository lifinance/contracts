import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import type { Environment } from '../types'

// Hardcoded RPC URLs
const RPC_URLS: Record<Environment, string> = {
  mainnet: 'https://api.trongrid.io',
  staging: 'https://api.shasta.trongrid.io',
}

export function initTronWeb(env: Environment, privateKey?: string): TronWeb {
  const rpcUrl = RPC_URLS[env]
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
): Promise<any> {
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
