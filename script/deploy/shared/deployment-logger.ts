/**
 * Deployment Logger - MongoDB-First Logging System
 *
 * This module provides a unified interface for logging contract deployments
 * with MongoDB as the primary source of truth. It handles:
 * - Writing deployment records to MongoDB
 * - Cache invalidation for fresh reads
 * - Optional local JSON file updates (for gradual migration)
 *
 * Usage:
 * ```typescript
 * import { logDeployment } from './deployment-logger'
 *
 * await logDeployment({
 *   contractName: 'DiamondCutFacet',
 *   network: 'mainnet',
 *   version: '1.0.0',
 *   address: '0x...',
 *   // ... other fields
 * })
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'

import { consola } from 'consola'

import type { EnvironmentEnum } from '../../common/types'

import type { DeploymentCache } from './deployment-cache'
import { createDefaultCache } from './deployment-cache'
import {
  DatabaseConnectionManager,
  type IDeploymentRecord,
  type IConfig,
} from './mongo-log-utils'

/**
 * Options for deployment logging
 */
export interface ILogOptions {
  /** Whether to update the local cache after logging (default: true) */
  updateCache?: boolean
  /** Whether to update the local JSON file (default: false, for gradual migration) */
  updateLocalJson?: boolean
  /** Whether to print success message (default: true) */
  silent?: boolean
}

/**
 * Configuration for the deployment logger
 */
export interface ILoggerConfig {
  /** MongoDB configuration */
  mongoConfig: IConfig
  /** Path to local JSON file (for backward compatibility) */
  localJsonPath?: string
  /** Cache instance (will create default if not provided) */
  cache?: DeploymentCache
}

/**
 * Deployment Logger class
 * Handles MongoDB-first logging with optional cache and JSON updates
 */
export class DeploymentLogger {
  private dbManager: DatabaseConnectionManager
  private cache: DeploymentCache
  private localJsonPath?: string

  /**
   * Creates a new DeploymentLogger instance
   * @param config - Logger configuration
   */
  public constructor(config: ILoggerConfig) {
    this.dbManager = DatabaseConnectionManager.getInstance(config.mongoConfig)
    this.cache = config.cache || createDefaultCache(config.mongoConfig)
    this.localJsonPath = config.localJsonPath
  }

  /**
   * Ensures MongoDB connection is established
   * @private
   */
  private async ensureConnection(): Promise<void> {
    if (!this.dbManager.isConnectionActive()) await this.dbManager.connect()
  }

  /**
   * Logs a deployment record to MongoDB
   * @param deployment - The deployment record to log
   * @param environment - The deployment environment
   * @param options - Logging options
   */
  public async log(
    deployment: Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'>,
    environment: keyof typeof EnvironmentEnum,
    options: ILogOptions = {}
  ): Promise<void> {
    const {
      updateCache = true,
      updateLocalJson = false,
      silent = false,
    } = options

    try {
      // Ensure connection
      await this.ensureConnection()

      // Get collection
      const collection =
        this.dbManager.getCollection<IDeploymentRecord>(environment)

      // Prepare record with metadata
      const now = new Date()
      const record: IDeploymentRecord = {
        ...deployment,
        createdAt: now,
        updatedAt: now,
        contractNetworkKey: `${deployment.contractName}-${deployment.network}`,
        contractVersionKey: `${deployment.contractName}-${deployment.version}`,
      }

      // Write to MongoDB (primary source)
      await collection.updateOne(
        {
          contractName: record.contractName,
          network: record.network,
          version: record.version,
          address: record.address,
        },
        {
          $set: {
            ...record,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      )

      if (!silent)
        consola.success(
          `Logged deployment: ${deployment.contractName} on ${deployment.network} at ${deployment.address}`
        )

      // Invalidate cache to force refresh on next read
      if (updateCache) await this.cache.invalidate(environment)

      // Optionally update local JSON file (for gradual migration)
      if (updateLocalJson && this.localJsonPath)
        await this.updateLocalJsonFile(record, environment)
    } catch (error) {
      consola.error(`Failed to log deployment: ${error}`)
      throw error
    }
  }

  /**
   * Batch logs multiple deployment records
   * More efficient than calling log() repeatedly
   *
   * @param deployments - Array of deployment records to log
   * @param environment - The deployment environment
   * @param options - Logging options
   */
  public async logBatch(
    deployments: Array<
      Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'>
    >,
    environment: keyof typeof EnvironmentEnum,
    options: ILogOptions = {}
  ): Promise<void> {
    const {
      updateCache = true,
      updateLocalJson = false,
      silent = false,
    } = options

    try {
      if (deployments.length === 0) {
        consola.warn('No deployments to log')
        return
      }

      // Ensure connection
      await this.ensureConnection()

      // Get collection
      const collection =
        this.dbManager.getCollection<IDeploymentRecord>(environment)

      const now = new Date()

      // Prepare bulk operations
      const operations = deployments.map((deployment) => {
        const record: IDeploymentRecord = {
          ...deployment,
          createdAt: now,
          updatedAt: now,
          contractNetworkKey: `${deployment.contractName}-${deployment.network}`,
          contractVersionKey: `${deployment.contractName}-${deployment.version}`,
        }

        // Exclude createdAt from $set to preserve original creation time on updates
        const { createdAt: _createdAt, ...recordWithoutCreatedAt } = record

        return {
          updateOne: {
            filter: {
              contractName: record.contractName,
              network: record.network,
              version: record.version,
              address: record.address,
            },
            update: {
              $set: {
                ...recordWithoutCreatedAt,
                updatedAt: now,
              },
              $setOnInsert: {
                createdAt: now,
              },
            },
            upsert: true,
          },
        }
      })

      // Execute batch write
      const result = await collection.bulkWrite(operations, { ordered: false })

      if (!silent)
        consola.success(
          `Logged ${deployments.length} deployments: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`
        )

      // Invalidate cache
      if (updateCache) await this.cache.invalidate(environment)

      // Optionally update local JSON file
      if (updateLocalJson && this.localJsonPath)
        for (const deployment of deployments) {
          const record: IDeploymentRecord = {
            ...deployment,
            createdAt: now,
            updatedAt: now,
            contractNetworkKey: `${deployment.contractName}-${deployment.network}`,
            contractVersionKey: `${deployment.contractName}-${deployment.version}`,
          }
          await this.updateLocalJsonFile(record, environment)
        }
    } catch (error) {
      consola.error(`Failed to log batch deployments: ${error}`)
      throw error
    }
  }

  /**
   * Updates the local JSON file with a deployment record
   * Used for gradual migration and backward compatibility
   *
   * @param record - The deployment record to add
   * @param environment - The deployment environment
   * @private
   */
  private async updateLocalJsonFile(
    record: IDeploymentRecord,
    environment: keyof typeof EnvironmentEnum
  ): Promise<void> {
    if (!this.localJsonPath) return

    try {
      // Read existing JSON
      let jsonData: Record<string, unknown> = {}
      if (existsSync(this.localJsonPath)) {
        const content = readFileSync(this.localJsonPath, 'utf8')
        jsonData = JSON.parse(content)
      }

      // Navigate/create nested structure
      if (!jsonData[record.contractName])
        jsonData[record.contractName] = {} as Record<string, unknown>

      const contractData = jsonData[record.contractName] as Record<
        string,
        unknown
      >
      if (!contractData[record.network])
        contractData[record.network] = {} as Record<string, unknown>

      const networkData = contractData[record.network] as Record<
        string,
        unknown
      >
      if (!networkData[environment])
        networkData[environment] = {} as Record<string, unknown>

      const envData = networkData[environment] as Record<string, unknown>
      if (!envData[record.version]) envData[record.version] = []

      const versionArray = envData[record.version] as unknown[]

      // Check if record already exists
      const existingIndex = versionArray.findIndex(
        (item: unknown) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { ADDRESS: string }).ADDRESS === record.address
      )

      // Create JSON-compatible record
      const jsonRecord = {
        ADDRESS: record.address,
        OPTIMIZER_RUNS: record.optimizerRuns,
        TIMESTAMP: record.timestamp.toISOString(),
        CONSTRUCTOR_ARGS: record.constructorArgs,
        SALT: record.salt || '',
        VERIFIED: record.verified ? 'true' : 'false',
        SOLC_VERSION: record.solcVersion || '',
        EVM_VERSION: record.evmVersion || '',
        ZK_SOLC_VERSION: record.zkSolcVersion || '',
      }

      if (existingIndex >= 0) versionArray[existingIndex] = jsonRecord
      else versionArray.push(jsonRecord)

      // Write updated JSON
      writeFileSync(this.localJsonPath, JSON.stringify(jsonData, null, 2))

      consola.debug(
        `Updated local JSON file: ${record.contractName} on ${record.network}`
      )
    } catch (error) {
      consola.warn(`Failed to update local JSON file: ${error}`)
      // Don't throw - this is optional/backward compatibility feature
    }
  }

  /**
   * Closes the MongoDB connection
   * Should be called when done with logging operations
   */
  public async close(): Promise<void> {
    await this.dbManager.disconnect()
  }
}

/**
 * Default logger instance (singleton pattern)
 */
let defaultLogger: DeploymentLogger | null = null

/**
 * Gets or creates the default logger instance
 * @returns Default DeploymentLogger instance
 * @throws Error if MONGODB_URI environment variable is not set
 */
function getDefaultLogger(): DeploymentLogger {
  if (!defaultLogger) {
    // Validate that MONGODB_URI is set - fail fast if not configured
    if (!process.env.MONGODB_URI) {
      consola.error('MONGODB_URI environment variable is not set.')
      consola.error(
        'MongoDB is required for deployment logging. Please set MONGODB_URI in your environment.'
      )
      throw new Error(
        'MONGODB_URI is required but not set. Cannot proceed with deployment logging.'
      )
    }

    const mongoConfig: IConfig = {
      mongoUri: process.env.MONGODB_URI,
      batchSize: 100,
      databaseName: 'contract-deployments',
    }

    defaultLogger = new DeploymentLogger({
      mongoConfig,
      localJsonPath: path.join(
        process.cwd(),
        'deployments/_deployments_log_file.json'
      ),
    })
  }

  return defaultLogger
}

/**
 * Convenience function to log a single deployment using the default logger
 *
 * @param deployment - The deployment record to log
 * @param environment - The deployment environment
 * @param options - Logging options
 *
 * @example
 * ```typescript
 * await logDeployment({
 *   contractName: 'DiamondCutFacet',
 *   network: 'mainnet',
 *   version: '1.0.0',
 *   address: '0x123...',
 *   optimizerRuns: '1000000',
 *   timestamp: new Date(),
 *   constructorArgs: '0x',
 *   verified: true,
 * }, 'production')
 * ```
 */
export async function logDeployment(
  deployment: Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'>,
  environment: 'staging' | 'production',
  options?: ILogOptions
): Promise<void> {
  const logger = getDefaultLogger()
  await logger.log(deployment, environment, options)
}

/**
 * Convenience function to log multiple deployments using the default logger
 *
 * @param deployments - Array of deployment records to log
 * @param environment - The deployment environment
 * @param options - Logging options
 */
export async function logDeploymentBatch(
  deployments: Array<
    Omit<IDeploymentRecord, 'createdAt' | 'updatedAt' | '_id'>
  >,
  environment: 'staging' | 'production',
  options?: ILogOptions
): Promise<void> {
  const logger = getDefaultLogger()
  await logger.logBatch(deployments, environment, options)
}
