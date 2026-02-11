import { consola } from 'consola'
import {
  MongoClient,
  type Db,
  type Collection,
  type ObjectId,
  type Document,
} from 'mongodb'

import type { EnvironmentEnum } from '../../common/types'
import { sleep } from '../../utils/delay'

/**
 * Represents a deployment record stored in MongoDB
 * @interface IDeploymentRecord
 */
export interface IDeploymentRecord {
  /** MongoDB document ID */
  _id?: ObjectId
  /** Name of the deployed contract */
  contractName: string
  /** Network where the contract was deployed (e.g., 'mainnet', 'polygon') */
  network: string
  /** Version of the contract */
  version: string
  /** Contract address on the blockchain */
  address: string
  /** Number of optimizer runs used during compilation */
  optimizerRuns: string
  /** Timestamp when the contract was deployed */
  timestamp: Date
  /** Constructor arguments used during deployment */
  constructorArgs: string
  /** Salt value used for CREATE3 deployments (empty string if not used) */
  salt: string
  /** Whether the contract has been verified on block explorer */
  verified: boolean
  /** Solidity compiler version used during deployment (empty string if not specified) */
  solcVersion: string
  /** EVM version used during deployment (empty string if not specified) */
  evmVersion: string
  /** ZK Solidity compiler version for zkSync deployments (empty string if not specified) */
  zkSolcVersion: string
  /** When this record was created in the database */
  createdAt: Date
  /** When this record was last updated in the database */
  updatedAt: Date
  /** Composite key for contract-network lookups */
  contractNetworkKey: string
  /** Composite key for contract-version lookups */
  contractVersionKey: string
}

/**
 * Configuration options for MongoDB connection and operations
 * @interface IConfig
 */
export interface IConfig {
  /** MongoDB connection URI */
  mongoUri: string
  /** Number of records to process in each batch operation */
  batchSize: number
  /** MongoDB database name */
  databaseName: string
}

/**
 * Extended configuration for update operations that need file paths
 */
export interface IUpdateConfig extends IConfig {
  /** Path to local JSON deployment log file */
  logFilePath: string
}

/**
 * Singleton class for managing MongoDB database connections
 * Provides a shared connection instance to avoid connection overhead
 * @class DatabaseConnectionManager
 */
export class DatabaseConnectionManager {
  private static instance: DatabaseConnectionManager
  private client: MongoClient | null = null
  private db: Db | null = null
  private isConnected = false

  /**
   * Private constructor to enforce singleton pattern
   * @param config - Database configuration options
   */
  private constructor(private config: IConfig) {}

  /**
   * Gets the singleton instance of the database connection manager
   * @param config - Database configuration options
   * @returns The singleton DatabaseConnectionManager instance
   */
  public static getInstance(config: IConfig): DatabaseConnectionManager {
    if (!DatabaseConnectionManager.instance)
      DatabaseConnectionManager.instance = new DatabaseConnectionManager(config)

    return DatabaseConnectionManager.instance
  }

  /**
   * Establishes connection to MongoDB with retry logic
   * Uses exponential backoff for retries on connection failures
   * @throws {Error} When connection fails after all retry attempts
   */
  public async connect(): Promise<void> {
    if (this.isConnected && this.client && this.db) return

    const maxRetries = 3
    let retryCount = 0

    while (retryCount < maxRetries)
      try {
        this.client = new MongoClient(this.config.mongoUri)
        await this.client.connect()
        this.db = this.client.db(this.config.databaseName)
        this.isConnected = true
        consola.info('Connected to MongoDB (shared connection)')
        return
      } catch (error) {
        retryCount++
        if (retryCount === maxRetries) {
          consola.error('Failed to connect to MongoDB after retries:', error)
          throw error
        }

        const delay = Math.pow(2, retryCount) * 1000
        consola.warn(`MongoDB connection failed, retrying in ${delay}ms...`)
        await sleep(delay)
      }
  }

  /**
   * Gets a MongoDB collection for the specified environment
   * @template T - The document type for the collection
   * @param environment - The deployment environment ('staging' or 'production')
   * @returns MongoDB collection instance
   * @throws {Error} When database is not connected
   */
  public getCollection<T extends Document = IDeploymentRecord>(
    environment: keyof typeof EnvironmentEnum
  ): Collection<T> {
    if (!this.db)
      throw new Error('Database not connected. Call connect() first.')

    return this.db.collection<T>(environment)
  }

  /**
   * Closes the MongoDB connection and cleans up resources
   */
  public async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      await this.client.close()
      this.client = null
      this.db = null
      this.isConnected = false
      consola.info('Disconnected from MongoDB')
    }
  }

  /**
   * Checks if the database connection is currently active
   * @returns True if connected, false otherwise
   */
  public isConnectionActive(): boolean {
    return this.isConnected && this.client !== null && this.db !== null
  }
}

/**
 * Utility class for validating deployment data and input parameters
 * Contains static methods for various validation scenarios
 * @class ValidationUtils
 */
export class ValidationUtils {
  /**
   * Validates if a timestamp string is valid and within reasonable bounds
   * @param timestamp - The timestamp string to validate
   * @returns True if the timestamp is valid, false otherwise
   */
  public static isValidTimestamp(timestamp: string): boolean {
    if (!timestamp || typeof timestamp !== 'string') return false

    if (timestamp.trim() === '' || timestamp === 'Invalid Date') return false

    const parsedDate = new Date(timestamp)

    if (isNaN(parsedDate.getTime())) return false

    const now = new Date()
    const minDate = new Date('2020-01-01')
    const maxDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)

    return parsedDate >= minDate && parsedDate <= maxDate
  }

  /**
   * Type guard to validate environment strings
   * @param env - The environment string to validate
   * @returns True if env is 'staging' or 'production'
   */
  public static isValidEnvironment(
    env: string
  ): env is keyof typeof EnvironmentEnum {
    return env === 'staging' || env === 'production'
  }

  /**
   * Type guard to validate if a partial record contains all required fields
   * @param record - Partial deployment record to validate
   * @returns True if all required fields are present
   */
  public static isValidDeploymentRecord(
    record: Partial<IDeploymentRecord>
  ): record is IDeploymentRecord {
    const required = ['contractName', 'network', 'version', 'address']
    return required.every((field) => record[field as keyof IDeploymentRecord])
  }

  /**
   * Validates raw deployment data from JSON files
   * Checks for required fields and proper data types
   * ALL fields must be strings - NO null or undefined allowed
   * Empty strings "" are acceptable for optional data
   * @param data - Unknown data to validate
   * @returns True if data matches expected raw deployment structure
   */
  public static isValidRawDeploymentData(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false

    const deployment = data as Record<string, unknown>

    // ALL fields are required and must be strings (can be empty string "")
    const requiredStringFields = [
      'ADDRESS',
      'OPTIMIZER_RUNS',
      'TIMESTAMP',
      'CONSTRUCTOR_ARGS',
      'SALT',
      'VERIFIED',
      'SOLC_VERSION',
      'EVM_VERSION',
      'ZK_SOLC_VERSION',
    ]

    // Check that all fields exist and are strings (NOT null or undefined)
    for (const field of requiredStringFields) {
      const value = deployment[field]
      // Explicitly reject null and undefined - only strings allowed
      if (value === null || value === undefined) return false
      if (typeof value !== 'string') return false
    }

    // ADDRESS must not be empty
    if (!deployment.ADDRESS) return false

    if (!ValidationUtils.isValidTimestamp(deployment.TIMESTAMP as string))
      return false

    const verified = deployment.VERIFIED as string
    if (verified !== 'true' && verified !== 'false') return false

    return true
  }

  /**
   * Validates that compiler version fields are present based on network type
   * @param record - The deployment record to validate
   * @param networkConfig - Optional network configuration (from networks.json)
   * @returns Array of warning messages for missing compiler versions (empty if all good)
   */
  public static validateCompilerVersions(
    record: IDeploymentRecord,
    networkConfig?: { isZkEVM?: boolean }
  ): string[] {
    const warnings: string[] = []

    // For zkEVM networks, we need zkSolcVersion
    if (networkConfig?.isZkEVM) {
      if (!record.zkSolcVersion || record.zkSolcVersion === '') {
        warnings.push(
          `zkEVM network '${record.network}' should have ZK_SOLC_VERSION but it's empty`
        )
      }
      // zkEVM networks may also have solcVersion and evmVersion
      if (!record.solcVersion || record.solcVersion === '') {
        warnings.push(
          `zkEVM network '${record.network}' should have SOLC_VERSION but it's empty`
        )
      }
    } else {
      // For regular EVM networks, we need solcVersion and evmVersion
      if (!record.solcVersion || record.solcVersion === '') {
        warnings.push(
          `EVM network '${record.network}' should have SOLC_VERSION but it's empty`
        )
      }
      if (!record.evmVersion || record.evmVersion === '') {
        warnings.push(
          `EVM network '${record.network}' should have EVM_VERSION but it's empty`
        )
      }
      // zkSolcVersion should be empty for non-zkEVM networks
      if (record.zkSolcVersion && record.zkSolcVersion !== '') {
        warnings.push(
          `Non-zkEVM network '${record.network}' has ZK_SOLC_VERSION but shouldn't`
        )
      }
    }

    return warnings
  }

  /**
   * Safely parses a string to integer with validation and constraints
   * @param value - String value to parse
   * @param defaultValue - Default value to return if parsing fails
   * @param min - Optional minimum value constraint
   * @param max - Optional maximum value constraint
   * @returns Parsed integer within constraints, or default value
   */
  public static safeParseInt(
    value: string | undefined,
    defaultValue: number,
    min?: number,
    max?: number
  ): number {
    if (!value || typeof value !== 'string') return defaultValue

    const trimmed = value.trim()
    if (trimmed === '') return defaultValue

    // Check if the string contains only digits (and optional leading minus for negative numbers)
    if (!/^-?\d+$/.test(trimmed)) return defaultValue

    const parsed = parseInt(trimmed, 10)

    // Check for NaN (shouldn't happen with our regex, but safety first)
    if (isNaN(parsed)) return defaultValue

    // Apply min/max constraints if provided
    if (min !== undefined && parsed < min) return min

    if (max !== undefined && parsed > max) return max

    return parsed
  }
}

/**
 * Manages MongoDB indexes for optimal query performance
 * Ensures required indexes exist on deployment collections
 * @class IndexManager
 */
export class IndexManager {
  /**
   * Creates necessary indexes on the deployment collection if they don't exist
   * Indexes are created for common query patterns:
   * - contract_network_version: For finding specific contract deployments
   * - contract_network_key_version: For composite key lookups
   * - timestamp_desc: For chronological queries (latest first)
   * - address: For address-based lookups
   *
   * @param collection - MongoDB collection to create indexes on
   */
  public static async ensureIndexes(
    collection: Collection<IDeploymentRecord>
  ): Promise<void> {
    const indexSpecs: Array<{
      key: Record<string, 1 | -1>
      name: string
    }> = [
      {
        key: { contractName: 1, network: 1, version: 1 },
        name: 'contract_network_version',
      },
      {
        key: { contractNetworkKey: 1, version: 1 },
        name: 'contract_network_key_version',
      },
      {
        key: { timestamp: -1 },
        name: 'timestamp_desc',
      },
      {
        key: { address: 1 },
        name: 'address',
      },
    ]

    try {
      const existingIndexes = await collection.listIndexes().toArray()
      const existingIndexNames = new Set(existingIndexes.map((idx) => idx.name))

      for (const indexSpec of indexSpecs)
        if (!existingIndexNames.has(indexSpec.name))
          try {
            await collection.createIndex(indexSpec.key, {
              name: indexSpec.name,
            })
            consola.info(`Created index: ${indexSpec.name}`)
          } catch (error) {
            consola.warn(`Failed to create index ${indexSpec.name}:`, error)
          }
    } catch (error) {
      consola.warn('Failed to list existing indexes:', error)
    }
  }
}

/**
 * Formats a deployment record for human-readable display
 * @param deployment - The deployment record to format
 * @returns Formatted string representation of the deployment
 */
export function formatDeployment(deployment: IDeploymentRecord): string {
  return `
Contract: ${deployment.contractName}
Network: ${deployment.network}
Version: ${deployment.version}
Address: ${deployment.address}
Timestamp: ${deployment.timestamp.toISOString()}
Verified: ${deployment.verified}
Optimizer Runs: ${deployment.optimizerRuns}
${deployment.salt ? `Salt: ${deployment.salt}` : ''}
---`
}

/**
 * Creates a unique key for a deployment record
 * Used for deduplication and comparison operations
 * @param record - The deployment record to create a key for
 * @returns Unique string key combining contract name, network, version, and address
 */
export function createDeploymentKey(record: IDeploymentRecord): string {
  return `${record.contractName}-${record.network}-${record.version}-${record.address}`
}

/**
 * Raw deployment data structure from JSON files
 * All fields are required - use empty string "" for not applicable fields
 * NO null or undefined values allowed
 */
export interface IRawDeploymentData {
  ADDRESS: string
  OPTIMIZER_RUNS: string
  TIMESTAMP: string
  CONSTRUCTOR_ARGS: string
  SALT: string
  VERIFIED: string
  SOLC_VERSION: string
  EVM_VERSION: string
  ZK_SOLC_VERSION: string
}

/**
 * Options for processing JSON data
 */
export interface IProcessJsonOptions {
  /** Callback for logging warnings about skipped records */
  onSkip?: (message: string) => void
}

/**
 * Handles transformation of raw JSON data to structured deployment records
 * Provides methods for converting between different data formats
 * @class RecordTransformer
 */
export class RecordTransformer {
  /**
   * Creates a transformer function that converts raw deployment data to IDeploymentRecord
   * Uses currying to pre-configure contract metadata
   * @param contractName - Name of the contract being deployed
   * @param network - Network where the contract was deployed
   * @param version - Version of the contract
   * @returns Function that transforms raw data to IDeploymentRecord or null if invalid
   */
  public static transformRawToDeployment =
    (contractName: string, network: string, version: string) =>
    (rawData: unknown): IDeploymentRecord | null => {
      if (!ValidationUtils.isValidRawDeploymentData(rawData)) return null

      // Type assertion is safe here because validation passed
      const validData = rawData as {
        ADDRESS: string
        OPTIMIZER_RUNS: string
        TIMESTAMP: string
        CONSTRUCTOR_ARGS: string
        VERIFIED: string
        SALT?: string
        SOLC_VERSION?: string
        EVM_VERSION?: string
        ZK_SOLC_VERSION?: string
      }

      try {
        return {
          contractName,
          network,
          version,
          address: validData.ADDRESS,
          optimizerRuns: validData.OPTIMIZER_RUNS,
          timestamp: new Date(validData.TIMESTAMP),
          constructorArgs: validData.CONSTRUCTOR_ARGS,
          // JSON is source of truth - all optional fields default to empty string
          salt: validData.SALT || '',
          verified: validData.VERIFIED === 'true',
          solcVersion: validData.SOLC_VERSION || '',
          evmVersion: validData.EVM_VERSION || '',
          zkSolcVersion: validData.ZK_SOLC_VERSION || '',
          createdAt: new Date(),
          updatedAt: new Date(),
          contractNetworkKey: `${contractName}-${network}`,
          contractVersionKey: `${contractName}-${version}`,
        }
      } catch {
        return null
      }
    }

  /**
   * Processes nested JSON data structure and extracts deployment records
   * Handles the complex nested structure: contract -> network -> environment -> version -> deployments[]
   * Filters by environment and validates each deployment record
   * @param jsonData - Raw JSON data from deployment log files
   * @param environment - Target environment to filter by ('staging' or 'production')
   * @param options - Optional configuration for logging and callbacks
   * @returns Array of valid deployment records
   */
  public static processJsonData(
    jsonData: unknown,
    environment: string,
    options: IProcessJsonOptions = {}
  ): IDeploymentRecord[] {
    const { onSkip = () => {} } = options

    if (!jsonData || typeof jsonData !== 'object') return []

    return Object.entries(jsonData).flatMap(
      ([contractName, contractData]: [string, unknown]) => {
        if (typeof contractData !== 'object' || contractData === null) {
          onSkip(`Skipping invalid contract data for: ${contractName}`)
          return []
        }

        return Object.entries(contractData).flatMap(
          ([network, networkData]: [string, unknown]) => {
            if (typeof networkData !== 'object' || networkData === null) {
              onSkip(
                `Skipping invalid network data for: ${contractName}.${network}`
              )
              return []
            }

            return Object.entries(networkData)
              .filter(([env]) => env === environment)
              .flatMap(([envName, envData]: [string, unknown]) => {
                if (typeof envData !== 'object' || envData === null) {
                  onSkip(
                    `Skipping invalid environment data for: ${contractName}.${network}.${envName}`
                  )
                  return []
                }

                return Object.entries(envData).flatMap(
                  ([version, deployments]: [string, unknown]) => {
                    if (!Array.isArray(deployments)) {
                      onSkip(
                        `Skipping invalid deployments array for: ${contractName}.${network}.${envName}.${version}`
                      )
                      return []
                    }

                    return deployments
                      .map((deployment) => {
                        const record =
                          RecordTransformer.transformRawToDeployment(
                            contractName,
                            network,
                            version
                          )(deployment)

                        if (record === null) {
                          onSkip(
                            `Skipping invalid deployment data: ${contractName} on ${network} (${envName}) v${version}`
                          )
                        }

                        return record
                      })
                      .filter(
                        (record): record is IDeploymentRecord => record !== null
                      )
                  }
                )
              })
          }
        )
      }
    )
  }
}
