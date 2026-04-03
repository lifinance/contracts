/**
 * TronScan explorer URLs (no dependency on TronWeb).
 */

import type { TronTvmNetworkName } from '../types'

/**
 * Builds a TronScan transaction URL. `txId` is hex with or without `0x`.
 */
export function tronScanTransactionUrl(
  networkKey: TronTvmNetworkName,
  txId: string
): string {
  const id = txId.replace(/^0x/i, '').toLowerCase()
  const base =
    networkKey === 'tronshasta'
      ? 'https://shasta.tronscan.org/#/transaction/'
      : 'https://tronscan.org/#/transaction/'

  return `${base}${id}`
}
