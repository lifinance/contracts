import { consola } from 'consola'
import type { TronWeb } from 'tronweb'

// Cache for prices with TTL
interface IPriceCache {
  energyPrice: number
  bandwidthPrice: number
  timestamp: number
}

let priceCache: IPriceCache | null = null
const CACHE_TTL = 60 * 60 * 1000 // 1 hour in milliseconds

// Fallback values (in TRX) - only used if API fails
const FALLBACK_ENERGY_PRICE = 0.00021 // TRX per energy unit
const FALLBACK_BANDWIDTH_PRICE = 0.001 // TRX per bandwidth point

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
  for (const { timestamp, price } of prices) 
    if (timestamp <= now) 
      return price
    
  

  // If all timestamps are in the future (shouldn't happen), use the oldest one
  const lastPrice = prices[prices.length - 1]
  return lastPrice ? lastPrice.price : 0
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
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_TTL) {
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
      energyPrice: FALLBACK_ENERGY_PRICE,
      bandwidthPrice: FALLBACK_BANDWIDTH_PRICE,
    }
  }
}

/**
 * Clear the price cache (useful for testing or forcing a refresh)
 */
export function clearPriceCache(): void {
  priceCache = null
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
