import { consola } from 'consola'
import {
  MongoClient,
  type Db,
  type Collection,
  type ObjectId,
  type Document,
} from 'mongodb'

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
  /** Optional salt value used for CREATE3 deployments */
  salt?: string
  /** Whether the contract has been verified on block explorer */
  verified: boolean
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
 * Options for paginating query results
 * @interface IPaginationOptions
 */
export interface IPaginationOptions {
  /** Page number (1-based) */
  page?: number
  /** Maximum number of records per page */
  limit?: number
  /** Number of records to skip from the beginning */
  offset?: number
}

/**
 * Paginated result wrapper containing data and pagination metadata
 * @interface IPaginatedResult
 * @template T The type of data being paginated
 */
export interface IPaginatedResult<T> {
  /** Array of data items for the current page */
  data: T[]
  /** Pagination metadata */
  pagination: {
    /** Current page number */
    page: number
    /** Number of items per page */
    limit: number
    /** Total number of items across all pages */
    total: number
    /** Total number of pages */
    totalPages: number
    /** Whether there is a next page */
    hasNext: boolean
    /** Whether there is a previous page */
    hasPrev: boolean
  }
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
        await new Promise((resolve) => setTimeout(resolve, delay))
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
    environment: 'staging' | 'production'
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
  ): env is 'staging' | 'production' {
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
   * @param data - Unknown data to validate
   * @returns True if data matches expected raw deployment structure
   */
  public static isValidRawDeploymentData(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false

    const deployment = data as Record<string, unknown>

    const requiredStringFields = [
      'ADDRESS',
      'OPTIMIZER_RUNS',
      'TIMESTAMP',
      'CONSTRUCTOR_ARGS',
      'VERIFIED',
    ]

    for (const field of requiredStringFields)
      if (typeof deployment[field] !== 'string' || !deployment[field])
        return false

    if (deployment.SALT !== undefined && typeof deployment.SALT !== 'string')
      return false

    if (!ValidationUtils.isValidTimestamp(deployment.TIMESTAMP as string))
      return false

    const verified = deployment.VERIFIED as string
    if (verified !== 'true' && verified !== 'false') return false

    return true
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
 * Utility class for handling pagination calculations and result formatting
 * @class PaginationUtils
 */
export class PaginationUtils {
  /**
   * Calculates pagination parameters for database queries
   * Enforces reasonable limits and handles edge cases
   * @param options - Pagination options from user input
   * @param _total - Total number of records (currently unused but kept for future use)
   * @returns Calculated skip, limit, and page values for database queries
   */
  public static calculatePagination(
    options: IPaginationOptions,
    _total: number
  ): { skip: number; limit: number; page: number } {
    const limit = Math.min(options.limit || 50, 1000)
    const page = Math.max(options.page || 1, 1)
    const skip = options.offset || (page - 1) * limit

    return { skip, limit, page }
  }

  /**
   * Creates a paginated result object with metadata
   * @template T - The type of data being paginated
   * @param data - Array of data items for the current page
   * @param totalCount - Total number of items across all pages
   * @param page - Current page number
   * @param limit - Number of items per page
   * @returns Formatted paginated result with metadata
   */
  public static createPaginatedResult<T>(
    data: T[],
    totalCount: number,
    page: number,
    limit: number
  ): IPaginatedResult<T> {
    const totalPages = Math.ceil(totalCount / limit)

    return {
      data,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
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
          salt: validData.SALT || undefined,
          verified: validData.VERIFIED === 'true',
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
   * @returns Array of valid deployment records
   */
  public static processJsonData(
    jsonData: unknown,
    environment: string
  ): IDeploymentRecord[] {
    if (!jsonData || typeof jsonData !== 'object') return []

    return Object.entries(jsonData).flatMap(
      ([contractName, contractData]: [string, unknown]) =>
        Object.entries(contractData || {}).flatMap(
          ([network, networkData]: [string, unknown]) =>
            Object.entries(networkData || {})
              .filter(([env]) => env === environment)
              .flatMap(([, envData]: [string, unknown]) =>
                Object.entries(envData || {}).flatMap(
                  ([version, deployments]: [string, unknown]) =>
                    Array.isArray(deployments)
                      ? deployments
                          .map(
                            RecordTransformer.transformRawToDeployment(
                              contractName,
                              network,
                              version
                            )
                          )
                          .filter(
                            (record): record is IDeploymentRecord =>
                              record !== null
                          )
                      : []
                )
              )
        )
    )
  }
}
