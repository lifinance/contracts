import type { EnvironmentEnum } from '../../common/types'

import type { DeploymentCache } from './deployment-cache'
import { createDefaultCache } from './deployment-cache'
import type { IDeploymentRecord, IConfig } from './mongo-log-utils'

/**
 * Cache-aware wrapper for deployment queries
 *
 * Provides a simple wrapper that adds caching to any deployment query function.
 * Instead of duplicating query logic, this uses the cache as a source and
 * performs filtering in-memory.
 *
 * Benefits:
 * - Fast reads from local cache (5-10ms vs 100-500ms MongoDB)
 * - Automatic TTL-based refresh
 * - Works offline with stale data
 * - Reuses existing query patterns
 *
 * Trade-offs:
 * - Loads full dataset into memory
 * - No MongoDB query optimization for complex filters
 * - Pagination is less efficient (filter then slice)
 */
export class CachedDeploymentQuerier {
  private cache: DeploymentCache

  public constructor(
    config: IConfig,
    private environment: keyof typeof EnvironmentEnum,
    cache?: DeploymentCache
  ) {
    this.cache = cache || createDefaultCache(config)
  }

  /**
   * Gets all records from cache (auto-refreshes if stale)
   * This is the core function that replaces MongoDB queries
   */
  private async getAllRecords(
    forceRefresh = false
  ): Promise<IDeploymentRecord[]> {
    return this.cache.get(this.environment, { forceRefresh })
  }

  /**
   * Get latest deployment for a contract on a network
   */
  public async getLatestDeployment(
    contractName: string,
    network: string
  ): Promise<IDeploymentRecord | null> {
    const records = await this.getAllRecords()

    // Filter in-memory
    const filtered = records.filter(
      (r) => r.contractName === contractName && r.network === network
    )

    if (filtered.length === 0) return null

    // Sort by timestamp desc and return first
    const sorted = filtered.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )
    return sorted[0] ?? null
  }

  /**
   * List deployments with pagination
   */
  public async listDeployments(
    contractName?: string,
    network?: string,
    limit = 50,
    page = 1
  ): Promise<{
    data: IDeploymentRecord[]
    pagination: {
      page: number
      limit: number
      total: number
      totalPages: number
      hasNext: boolean
      hasPrev: boolean
    }
  }> {
    const records = await this.getAllRecords()

    // Apply filters
    let filtered = records
    if (contractName) {
      filtered = filtered.filter((r) => r.contractName === contractName)
    }
    if (network) {
      filtered = filtered.filter((r) => r.network === network)
    }

    // Sort by timestamp desc
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Calculate pagination
    const total = filtered.length
    const totalPages = Math.ceil(total / limit)
    const skip = (page - 1) * limit

    // Apply pagination
    const data = filtered.slice(skip, skip + limit)

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    }
  }

  /**
   * Find deployment by address
   */
  public async findByAddress(
    address: string,
    network: string
  ): Promise<IDeploymentRecord | null> {
    const records = await this.getAllRecords()
    const normalizedAddress = address.toLowerCase()

    return (
      records.find((r) => r.address.toLowerCase() === normalizedAddress && r.network === network) ||
      null
    )
  }

  /**
   * Filter deployments by multiple criteria
   */
  public async filterDeployments(filters: {
    contractName?: string
    network?: string
    version?: string
    verified?: boolean
    limit?: number
  }): Promise<IDeploymentRecord[]> {
    const records = await this.getAllRecords()

    // Apply filters in-memory
    let filtered = records

    if (filters.contractName) {
      filtered = filtered.filter((r) => r.contractName === filters.contractName)
    }
    if (filters.network) {
      filtered = filtered.filter((r) => r.network === filters.network)
    }
    if (filters.version) {
      filtered = filtered.filter((r) => r.version === filters.version)
    }
    if (filters.verified !== undefined) {
      filtered = filtered.filter((r) => r.verified === filters.verified)
    }

    // Sort by timestamp desc
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

    // Apply limit
    if (filters.limit) {
      filtered = filtered.slice(0, filters.limit)
    }

    return filtered
  }

  /**
   * Get deployment history for a contract on a network
   */
  public async getDeploymentHistory(
    contractName: string,
    network: string
  ): Promise<IDeploymentRecord[]> {
    const records = await this.getAllRecords()

    const filtered = records.filter(
      (r) => r.contractName === contractName && r.network === network
    )

    // Sort by timestamp desc
    return filtered.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    )
  }

  /**
   * Force refresh cache from MongoDB
   */
  public async refreshCache(): Promise<void> {
    await this.cache.refresh(this.environment)
  }

  /**
   * Get cache statistics
   */
  public async getCacheStats(): Promise<{
    exists: boolean
    recordCount: number
    lastRefresh: string | null
    age: string | null
    isStale: boolean
  }> {
    return this.cache.getStats(this.environment)
  }
}
