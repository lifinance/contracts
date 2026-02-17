import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import path from 'path'

import { consola } from 'consola'

import type { EnvironmentEnum } from '../../common/types'

import {
  type IDeploymentRecord,
  DatabaseConnectionManager,
  type IConfig,
} from './mongo-log-utils'

/**
 * Metadata for the deployment cache
 * Tracks when the cache was last refreshed and data integrity info
 */
interface ICacheMetadata {
  lastRefresh: string // ISO timestamp
  environment: keyof typeof EnvironmentEnum
  recordCount: number
  version: string
}

/**
 * Configuration for the cache system
 */
interface ICacheConfig {
  cacheDir: string
  ttl: number // Time-to-live in milliseconds
  mongoConfig: IConfig
}

/**
 * Configuration for lock behavior
 */
interface ILockOptions {
  timeout?: number // Max time to wait for lock in ms (default: 30000)
  staleThreshold?: number // Age in ms after which lock is considered stale (default: 60000)
}

const DEFAULT_LOCK_OPTIONS: Required<ILockOptions> = {
  timeout: 30000,
  staleThreshold: 60000,
}

/**
 * Sleeps for the specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Local file-based cache for deployment records
 * Provides fast read access while maintaining MongoDB as source of truth
 *
 * Features:
 * - Automatic TTL-based refresh
 * - Manual invalidation
 * - Fallback to MongoDB on cache miss
 * - Offline support with stale data warning
 *
 * @class DeploymentCache
 */
export class DeploymentCache {
  private cacheDir: string
  private ttl: number
  private mongoConfig: IConfig

  /**
   * Creates a new DeploymentCache instance
   * @param config - Cache configuration options
   */
  public constructor(config: ICacheConfig) {
    this.cacheDir = config.cacheDir
    this.ttl = config.ttl
    this.mongoConfig = config.mongoConfig

    // Ensure cache directory exists
    this.ensureCacheDir()
  }

  /**
   * Ensures the cache directory exists, creating it if necessary
   * @private
   */
  private ensureCacheDir(): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
      consola.debug(`Created cache directory: ${this.cacheDir}`)
    }
  }

  /**
   * Gets the lock directory path for a given environment
   * @param environment - The deployment environment
   * @returns Full path to the lock directory
   * @private
   */
  private getLockPath(environment: keyof typeof EnvironmentEnum): string {
    return path.join(this.cacheDir, `deployments_${environment}.lock`)
  }

  /**
   * Checks if a lock is stale (older than threshold)
   * @param lockPath - Path to the lock directory
   * @param staleThreshold - Age in ms after which lock is considered stale
   * @returns True if lock is stale
   * @private
   */
  private isLockStale(lockPath: string, staleThreshold: number): boolean {
    try {
      const stats = statSync(lockPath)
      const age = Date.now() - stats.mtimeMs
      return age > staleThreshold
    } catch {
      return false
    }
  }

  /**
   * Acquires an exclusive lock for cache operations
   * Uses mkdir which is atomic on POSIX systems
   * @param environment - The deployment environment
   * @param options - Lock configuration options
   * @returns True if lock acquired, false if timeout
   * @private
   */
  private async acquireLock(
    environment: keyof typeof EnvironmentEnum,
    options: ILockOptions = {}
  ): Promise<boolean> {
    const { timeout, staleThreshold } = { ...DEFAULT_LOCK_OPTIONS, ...options }
    const lockPath = this.getLockPath(environment)
    const start = Date.now()

    while (Date.now() - start < timeout) {
      try {
        mkdirSync(lockPath)
        consola.debug(`Lock acquired for ${environment}`)
        return true
      } catch (error: unknown) {
        // Check if lock exists and is stale
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          if (this.isLockStale(lockPath, staleThreshold)) {
            consola.warn(`Removing stale lock for ${environment}`)
            try {
              rmdirSync(lockPath)
              continue // Retry immediately after removing stale lock
            } catch {
              // Another process may have removed it, continue waiting
            }
          }
        }
        // Wait before retrying
        await sleep(100)
      }
    }

    consola.error(`Timeout waiting for lock on ${environment}`)
    return false
  }

  /**
   * Releases the lock for cache operations
   * @param environment - The deployment environment
   * @private
   */
  private releaseLock(environment: keyof typeof EnvironmentEnum): void {
    const lockPath = this.getLockPath(environment)
    try {
      rmdirSync(lockPath)
      consola.debug(`Lock released for ${environment}`)
    } catch (error) {
      consola.warn(`Failed to release lock for ${environment}: ${error}`)
    }
  }

  /**
   * Executes a function with an exclusive lock
   * @param environment - The deployment environment
   * @param fn - Function to execute while holding the lock
   * @param options - Lock configuration options
   * @returns Result of the function
   * @private
   */
  private async withLock<T>(
    environment: keyof typeof EnvironmentEnum,
    fn: () => Promise<T>,
    options: ILockOptions = {}
  ): Promise<T> {
    const acquired = await this.acquireLock(environment, options)
    if (!acquired) {
      throw new Error(`Failed to acquire lock for ${environment} cache`)
    }

    try {
      return await fn()
    } finally {
      this.releaseLock(environment)
    }
  }

  /**
   * Gets the file path for the cache data file
   * @param environment - The deployment environment
   * @returns Full path to the cache data file
   * @private
   */
  private getCacheFilePath(environment: keyof typeof EnvironmentEnum): string {
    return path.join(this.cacheDir, `deployments_${environment}.json`)
  }

  /**
   * Gets the file path for the cache metadata file
   * @param environment - The deployment environment
   * @returns Full path to the metadata file
   * @private
   */
  private getMetadataFilePath(
    environment: keyof typeof EnvironmentEnum
  ): string {
    return path.join(this.cacheDir, `deployments_${environment}.metadata.json`)
  }

  /**
   * Checks if the cache is stale based on TTL
   * @param lastRefresh - ISO timestamp of last refresh
   * @returns True if cache is stale and needs refresh
   * @private
   */
  private isStale(lastRefresh: string): boolean {
    const lastRefreshTime = new Date(lastRefresh).getTime()
    const now = Date.now()
    return now - lastRefreshTime > this.ttl
  }

  /**
   * Reads metadata from the cache
   * @param environment - The deployment environment
   * @returns Cache metadata or null if not found
   * @private
   */
  private readMetadata(
    environment: keyof typeof EnvironmentEnum
  ): ICacheMetadata | null {
    const metadataPath = this.getMetadataFilePath(environment)
    if (!existsSync(metadataPath)) return null

    try {
      const content = readFileSync(metadataPath, 'utf8')
      return JSON.parse(content) as ICacheMetadata
    } catch (error) {
      consola.warn(`Failed to read cache metadata: ${error}`)
      return null
    }
  }

  /**
   * Writes metadata to the cache
   * @param environment - The deployment environment
   * @param metadata - Metadata to write
   * @private
   */
  private writeMetadata(
    environment: keyof typeof EnvironmentEnum,
    metadata: ICacheMetadata
  ): void {
    const metadataPath = this.getMetadataFilePath(environment)
    try {
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))
    } catch (error) {
      consola.error(`Failed to write cache metadata: ${error}`)
    }
  }

  /**
   * Reads deployment records from the cache
   * @param environment - The deployment environment
   * @returns Array of deployment records or null if cache miss
   * @private
   */
  private readCache(
    environment: keyof typeof EnvironmentEnum
  ): IDeploymentRecord[] | null {
    const cachePath = this.getCacheFilePath(environment)
    if (!existsSync(cachePath)) return null

    try {
      const content = readFileSync(cachePath, 'utf8')
      const records = JSON.parse(content) as IDeploymentRecord[]

      // Convert timestamp strings back to Date objects
      return records.map((record) => ({
        ...record,
        timestamp: new Date(record.timestamp),
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      }))
    } catch (error) {
      consola.warn(`Failed to read cache data: ${error}`)
      return null
    }
  }

  /**
   * Writes deployment records to the cache
   * @param environment - The deployment environment
   * @param records - Records to write
   * @private
   */
  private writeCache(
    environment: keyof typeof EnvironmentEnum,
    records: IDeploymentRecord[]
  ): void {
    const cachePath = this.getCacheFilePath(environment)
    try {
      writeFileSync(cachePath, JSON.stringify(records, null, 2))

      // Update metadata
      const metadata: ICacheMetadata = {
        lastRefresh: new Date().toISOString(),
        environment,
        recordCount: records.length,
        version: '1.0.0',
      }
      this.writeMetadata(environment, metadata)

      consola.debug(
        `Cache updated: ${records.length} records written for ${environment}`
      )
    } catch (error) {
      consola.error(`Failed to write cache data: ${error}`)
    }
  }

  /**
   * Gets deployment records from cache or MongoDB
   * Automatically refreshes cache if stale
   *
   * @param environment - The deployment environment
   * @param options - Options for cache behavior
   * @returns Array of deployment records
   *
   * @example
   * ```typescript
   * const cache = new DeploymentCache(config)
   * const records = await cache.get('production')
   * ```
   */
  public async get(
    environment: keyof typeof EnvironmentEnum,
    options: { forceRefresh?: boolean } = {}
  ): Promise<IDeploymentRecord[]> {
    // Check if force refresh is requested
    if (options.forceRefresh) {
      consola.debug('Force refresh requested, fetching from MongoDB')
      return this.refresh(environment)
    }

    // Read metadata to check if cache is valid
    const metadata = this.readMetadata(environment)

    if (!metadata) {
      consola.debug('Cache miss (no metadata), fetching from MongoDB')
      return this.refresh(environment)
    }

    // Check if cache is stale
    if (this.isStale(metadata.lastRefresh)) {
      consola.debug('Cache is stale, refreshing from MongoDB')
      return this.refresh(environment)
    }

    // Try to read from cache
    const cachedRecords = this.readCache(environment)

    if (!cachedRecords) {
      consola.warn('Cache metadata exists but data file is missing, refreshing')
      return this.refresh(environment)
    }

    // Validate cache integrity
    if (cachedRecords.length !== metadata.recordCount) {
      consola.warn(
        `Cache integrity issue: expected ${metadata.recordCount} records, found ${cachedRecords.length}`
      )
      return this.refresh(environment)
    }

    // Use stderr so stdout stays JSON-only when used from bash (e.g. query-deployment-logs filter/get)
    process.stderr.write(
      `[debug] Cache hit: ${
        cachedRecords.length
      } records loaded from cache (age: ${this.getCacheAge(
        metadata.lastRefresh
      )})\n`
    )
    return cachedRecords
  }

  /**
   * Refreshes the cache from MongoDB
   * @param environment - The deployment environment
   * @returns Updated array of deployment records
   *
   * @example
   * ```typescript
   * const cache = new DeploymentCache(config)
   * await cache.refresh('production')
   * ```
   */
  public async refresh(
    environment: keyof typeof EnvironmentEnum
  ): Promise<IDeploymentRecord[]> {
    return this.withLock(environment, async () => {
      // Double-check if cache is still stale after acquiring lock
      // Another process may have refreshed it while we were waiting
      const metadata = this.readMetadata(environment)
      if (metadata && !this.isStale(metadata.lastRefresh)) {
        const cachedRecords = this.readCache(environment)
        if (cachedRecords && cachedRecords.length === metadata.recordCount) {
          consola.debug(
            `Cache was refreshed by another process, using cached data`
          )
          return cachedRecords
        }
      }

      consola.info(`Refreshing ${environment} cache from MongoDB...`)

      const dbManager = DatabaseConnectionManager.getInstance(this.mongoConfig)

      try {
        await dbManager.connect()
        const collection =
          dbManager.getCollection<IDeploymentRecord>(environment)

        // Fetch all records from MongoDB
        const records = await collection.find({}).toArray()

        consola.info(`Fetched ${records.length} records from MongoDB`)

        // Write to cache
        this.writeCache(environment, records)

        return records
      } catch (error) {
        consola.error(`Failed to refresh cache from MongoDB: ${error}`)

        // Try to return stale cache data as fallback
        const staleData = this.readCache(environment)
        if (staleData) {
          consola.warn(
            `Using stale cache data (${staleData.length} records) as fallback`
          )
          return staleData
        }

        throw error
      } finally {
        await dbManager.disconnect()
      }
    })
  }

  /**
   * Invalidates the cache, forcing next read to fetch from MongoDB
   * @param environment - Optional environment to invalidate, or all if not specified
   *
   * @example
   * ```typescript
   * const cache = new DeploymentCache(config)
   * await cache.invalidate('production')  // Invalidate specific environment
   * await cache.invalidate()              // Invalidate all
   * ```
   */
  public async invalidate(
    environment?: keyof typeof EnvironmentEnum
  ): Promise<void> {
    if (environment) {
      // Update metadata to mark as stale (set lastRefresh to epoch)
      const metadata: ICacheMetadata = {
        lastRefresh: new Date(0).toISOString(),
        environment,
        recordCount: 0,
        version: '1.0.0',
      }
      this.writeMetadata(environment, metadata)

      consola.debug(`Invalidated ${environment} cache`)
    } else {
      // Invalidate both environments
      await this.invalidate('staging')
      await this.invalidate('production')
      consola.debug('Invalidated all caches')
    }
  }

  /**
   * Gets the age of the cache in human-readable format
   * @param lastRefresh - ISO timestamp of last refresh
   * @returns Human-readable age string
   * @private
   */
  private getCacheAge(lastRefresh: string): string {
    const ageMs = Date.now() - new Date(lastRefresh).getTime()
    const ageMinutes = Math.floor(ageMs / (1000 * 60))
    const ageHours = Math.floor(ageMinutes / 60)
    const ageDays = Math.floor(ageHours / 24)

    if (ageDays > 0) return `${ageDays}d ${ageHours % 24}h`

    if (ageHours > 0) return `${ageHours}h ${ageMinutes % 60}m`

    return `${ageMinutes}m`
  }

  /**
   * Gets cache statistics for monitoring
   * @param environment - The deployment environment
   * @returns Cache statistics object
   */
  public async getStats(environment: keyof typeof EnvironmentEnum): Promise<{
    exists: boolean
    recordCount: number
    lastRefresh: string | null
    age: string | null
    isStale: boolean
  }> {
    const metadata = this.readMetadata(environment)

    if (!metadata)
      return {
        exists: false,
        recordCount: 0,
        lastRefresh: null,
        age: null,
        isStale: true,
      }

    return {
      exists: true,
      recordCount: metadata.recordCount,
      lastRefresh: metadata.lastRefresh,
      age: this.getCacheAge(metadata.lastRefresh),
      isStale: this.isStale(metadata.lastRefresh),
    }
  }
}

/**
 * Creates a default cache instance with standard configuration
 * @param mongoConfig - MongoDB configuration
 * @returns Configured DeploymentCache instance
 */
export function createDefaultCache(mongoConfig: IConfig): DeploymentCache {
  return new DeploymentCache({
    cacheDir: path.join(process.cwd(), '.cache'),
    ttl: 5 * 60 * 1000, // 5 minutes
    mongoConfig,
  })
}
