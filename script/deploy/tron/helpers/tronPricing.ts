import { consola } from 'consola'
import type { TronWeb } from 'tronweb'

import {
  A_SIGNATURE,
  DATA_HEX_PROTOBUF_EXTRA,
  FALLBACK_BANDWIDTH_PRICE_TRX,
  FALLBACK_ENERGY_PRICE_TRX,
  MAX_RESULT_SIZE_IN_TX,
  PRICE_CACHE_TTL_MS,
} from '../constants'
import type { IAccountResourceResponse, IPriceCache } from '../types'

let priceCache: IPriceCache | null = null

/**
 * Parse the latest applicable price from Tron's price history string
 * Format: "timestamp1:price1,timestamp2:price2,..."
 * Returns the price in SUN for the most recent timestamp that's not in the future
 */
function parseLatestPrice(priceString: string): number {
  const now = Date.now()
  const prices = priceString.split(',').map((entry) => {
    const parts = entry.split(':')
    const timestamp = Number(parts[0] || 0)
    const price = Number(parts[1] || 0)
    return { timestamp, price }
  })

  // Sort by timestamp descending
  prices.sort((a, b) => b.timestamp - a.timestamp)

  // Find the most recent price that's not in the future
  for (const { timestamp, price } of prices) if (timestamp <= now) return price

  // If all timestamps are in the future (shouldn't happen), use the oldest one
  const lastPrice = prices[prices.length - 1]
  return lastPrice ? lastPrice.price : 0
}

/**
 * Calculate transaction bandwidth
 */
export function calculateTransactionBandwidth(transaction: any): number {
  const rawDataLength = transaction.raw_data_hex
    ? transaction.raw_data_hex.length / 2
    : JSON.stringify(transaction.raw_data).length

  const signatureCount = transaction.signature?.length || 1

  return (
    rawDataLength +
    DATA_HEX_PROTOBUF_EXTRA +
    MAX_RESULT_SIZE_IN_TX +
    signatureCount * A_SIGNATURE
  )
}

/**
 * Get current energy and bandwidth prices from the Tron network
 * Prices are returned in TRX (not SUN)
 * Results are cached for 1 hour to reduce API calls
 */
export async function getCurrentPrices(
  tronWeb: TronWeb
): Promise<{ energyPrice: number; bandwidthPrice: number }> {
  // Check cache first
  if (priceCache && Date.now() - priceCache.timestamp < PRICE_CACHE_TTL_MS) {
    consola.debug('Using cached prices')
    return {
      energyPrice: priceCache.energyPrice,
      bandwidthPrice: priceCache.bandwidthPrice,
    }
  }

  try {
    consola.debug('Fetching current prices from Tron network...')

    const [energyPricesStr, bandwidthPricesStr] = await Promise.all([
      tronWeb.trx.getEnergyPrices(),
      tronWeb.trx.getBandwidthPrices(),
    ])

    // Parse the price strings to get the latest applicable prices
    const energyPriceSun = parseLatestPrice(energyPricesStr)
    const bandwidthPriceSun = parseLatestPrice(bandwidthPricesStr)

    // Convert from SUN to TRX (1 TRX = 1,000,000 SUN)
    const energyPrice = energyPriceSun / 1_000_000
    const bandwidthPrice = bandwidthPriceSun / 1_000_000

    // Update cache
    priceCache = {
      energyPrice,
      bandwidthPrice,
      timestamp: Date.now(),
    }

    consola.debug(
      `Current prices - Energy: ${energyPrice} TRX, Bandwidth: ${bandwidthPrice} TRX`
    )

    return { energyPrice, bandwidthPrice }
  } catch (error) {
    consola.warn(
      'Failed to fetch current prices from network, using fallback values:',
      error
    )

    // Use fallback values if API fails
    return {
      energyPrice: FALLBACK_ENERGY_PRICE_TRX,
      bandwidthPrice: FALLBACK_BANDWIDTH_PRICE_TRX,
    }
  }
}

/**
 * Get account's available delegated (or owned) energy and bandwidth.
 * Used to reduce required TRX when the account has delegated resources.
 */
export async function getAccountAvailableResources(
  fullHost: string,
  addressBase58: string
): Promise<{ availableEnergy: number; availableBandwidth: number }> {
  const url = fullHost.replace(/\/$/, '') + '/wallet/getaccountresource'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addressBase58, visible: true }),
  })
  if (!res.ok) {
    return { availableEnergy: 0, availableBandwidth: 0 }
  }
  const data = (await res.json()) as IAccountResourceResponse
  const energyLimit = data.EnergyLimit ?? data.energy_limit ?? 0
  const energyUsed = data.EnergyUsed ?? data.energy_used ?? 0
  const netLimit = data.NetLimit ?? data.net_limit ?? 0
  const netUsed = data.NetUsed ?? data.net_used ?? 0
  const freeNetLimit = data.freeNetLimit ?? data.free_net_limit ?? 0
  const freeNetUsed = data.freeNetUsed ?? data.free_net_used ?? 0
  const availableEnergy = Math.max(0, energyLimit - energyUsed)
  const availableBandwidth =
    Math.max(0, netLimit - netUsed) + Math.max(0, freeNetLimit - freeNetUsed)
  return { availableEnergy, availableBandwidth }
}

/**
 * Calculate the estimated cost in TRX based on energy and bandwidth usage
 */
export async function calculateEstimatedCost(
  tronWeb: TronWeb,
  estimatedEnergy: number,
  estimatedBandwidth = 0
): Promise<{ energyCost: number; bandwidthCost: number; totalCost: number }> {
  const { energyPrice, bandwidthPrice } = await getCurrentPrices(tronWeb)

  const energyCost = estimatedEnergy * energyPrice
  const bandwidthCost = estimatedBandwidth * bandwidthPrice
  const totalCost = energyCost + bandwidthCost

  return {
    energyCost,
    bandwidthCost,
    totalCost,
  }
}
