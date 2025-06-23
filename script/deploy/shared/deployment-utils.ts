import { consola } from 'consola'
import {
  MongoClient,
  type Db,
  type Collection,
  type ObjectId,
  type Document,
} from 'mongodb'

export interface IDeploymentRecord {
  _id?: ObjectId
  contractName: string
  network: string
  version: string
  address: string
  optimizerRuns: string
  timestamp: Date
  constructorArgs: string
  salt?: string
  verified: boolean
  createdAt: Date
  updatedAt: Date
  contractNetworkKey: string
  contractVersionKey: string
}

export interface IConfig {
  mongoUri: string
  batchSize: number
}

export interface IPaginationOptions {
  page?: number
  limit?: number
  offset?: number
}

export interface IPaginatedResult<T> {
  data: T[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
}

export class DatabaseConnectionManager {
  private static instance: DatabaseConnectionManager
  private client: MongoClient | null = null
  private db: Db | null = null
  private isConnected = false

  private constructor(private config: IConfig) {}

  public static getInstance(config: IConfig): DatabaseConnectionManager {
    if (!DatabaseConnectionManager.instance)
      DatabaseConnectionManager.instance = new DatabaseConnectionManager(config)

    return DatabaseConnectionManager.instance
  }

  public async connect(): Promise<void> {
    if (this.isConnected && this.client && this.db) return

    const maxRetries = 3
    let retryCount = 0

    while (retryCount < maxRetries)
      try {
        this.client = new MongoClient(this.config.mongoUri)
        await this.client.connect()
        this.db = this.client.db('contract-deployments')
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

  public getCollection<T extends Document = IDeploymentRecord>(
    environment: 'staging' | 'production'
  ): Collection<T> {
    if (!this.db)
      throw new Error('Database not connected. Call connect() first.')

    return this.db.collection<T>(environment)
  }

  public async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      await this.client.close()
      this.client = null
      this.db = null
      this.isConnected = false
      consola.info('Disconnected from MongoDB')
    }
  }

  public isConnectionActive(): boolean {
    return this.isConnected && this.client !== null && this.db !== null
  }
}

export class ValidationUtils {
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

  public static isValidEnvironment(
    env: string
  ): env is 'staging' | 'production' {
    return env === 'staging' || env === 'production'
  }

  public static isValidDeploymentRecord(
    record: Partial<IDeploymentRecord>
  ): record is IDeploymentRecord {
    const required = ['contractName', 'network', 'version', 'address']
    return required.every((field) => record[field as keyof IDeploymentRecord])
  }

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

  public static safeParseInt(
    value: string | undefined,
    defaultValue: number,
    min?: number,
    max?: number
  ): number {
    if (!value || typeof value !== 'string') 
      return defaultValue
    

    const trimmed = value.trim()
    if (trimmed === '') 
      return defaultValue
    

    // Check if the string contains only digits (and optional leading minus for negative numbers)
    if (!/^-?\d+$/.test(trimmed)) 
      return defaultValue
    

    const parsed = parseInt(trimmed, 10)

    // Check for NaN (shouldn't happen with our regex, but safety first)
    if (isNaN(parsed)) 
      return defaultValue
    

    // Apply min/max constraints if provided
    if (min !== undefined && parsed < min) 
      return min
    
    if (max !== undefined && parsed > max) 
      return max
    

    return parsed
  }
}

export class IndexManager {
  public static async ensureIndexes(
    collection: Collection<IDeploymentRecord>
  ): Promise<void> {
    const indexSpecs = [
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
            await collection.createIndex(indexSpec.key as any, {
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

export class PaginationUtils {
  public static calculatePagination(
    options: IPaginationOptions,
    _total: number
  ): { skip: number; limit: number; page: number } {
    const limit = Math.min(options.limit || 50, 1000)
    const page = Math.max(options.page || 1, 1)
    const skip = options.offset || (page - 1) * limit

    return { skip, limit, page }
  }

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

export function createDeploymentKey(record: IDeploymentRecord): string {
  return `${record.contractName}-${record.network}-${record.version}-${record.address}`
}

export class RecordTransformer {
  public static transformRawToDeployment =
    (
      contractName: string,
      network: string,
      version: string,
      _environment: string
    ) =>
    (rawData: any): IDeploymentRecord | null => {
      if (!ValidationUtils.isValidRawDeploymentData(rawData)) return null

      try {
        return {
          contractName,
          network,
          version,
          address: rawData.ADDRESS,
          optimizerRuns: rawData.OPTIMIZER_RUNS,
          timestamp: new Date(rawData.TIMESTAMP),
          constructorArgs: rawData.CONSTRUCTOR_ARGS,
          salt: rawData.SALT || undefined,
          verified: rawData.VERIFIED === 'true',
          createdAt: new Date(),
          updatedAt: new Date(),
          contractNetworkKey: `${contractName}-${network}`,
          contractVersionKey: `${contractName}-${version}`,
        }
      } catch {
        return null
      }
    }

  public static processJsonData(
    jsonData: any,
    environment: string
  ): IDeploymentRecord[] {
    if (!jsonData || typeof jsonData !== 'object') return []

    return Object.entries(jsonData).flatMap(
      ([contractName, contractData]: [string, any]) =>
        Object.entries(contractData || {}).flatMap(
          ([network, networkData]: [string, any]) =>
            Object.entries(networkData || {})
              .filter(([env]) => env === environment)
              .flatMap(([, envData]: [string, any]) =>
                Object.entries(envData || {}).flatMap(
                  ([version, deployments]: [string, any]) =>
                    Array.isArray(deployments)
                      ? deployments
                          .map(
                            RecordTransformer.transformRawToDeployment(
                              contractName,
                              network,
                              version,
                              environment
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
