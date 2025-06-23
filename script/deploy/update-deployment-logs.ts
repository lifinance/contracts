#!/usr/bin/env bun

/**
 * Update Deployment Logs
 *
 * This script manages deployment logs stored in MongoDB for contract deployments.
 * It can sync deployment data from JSON files, add new records, or update existing ones.
 * Supports both production and staging environments with separate collections.
 */

import { readFileSync } from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { type Db, type Collection, type ObjectId, MongoClient } from 'mongodb'

// TypeScript interface for deployment records
interface IDeploymentRecord {
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

  // Metadata for tracking
  createdAt: Date
  updatedAt: Date

  // Composite fields for efficient querying
  contractNetworkKey: string // `${contractName}-${network}`
  contractVersionKey: string // `${contractName}-${version}`
}

// Type definitions for the expected JSON data structure
interface IRawDeploymentData {
  ADDRESS: string
  OPTIMIZER_RUNS: string
  TIMESTAMP: string
  CONSTRUCTOR_ARGS: string
  SALT?: string
  VERIFIED: string
}

interface IJsonDataStructure {
  [contractName: string]: {
    [network: string]: {
      [environment: string]: {
        [version: string]: IRawDeploymentData[]
      }
    }
  }
}

// Configuration interface
interface IConfig {
  mongoUri: string
  logFilePath: string
  batchSize: number
}

// Configuration setup
const config: IConfig = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  logFilePath: path.join(
    process.cwd(),
    'deployments/_deployments_log_file.json'
  ),
  batchSize: 100,
}

class DeploymentLogManager {
  private client: MongoClient
  private db: Db
  private collection: Collection<IDeploymentRecord>

  public constructor(
    private config: IConfig,
    private environment: 'staging' | 'production'
  ) {
    this.client = new MongoClient(config.mongoUri)
  }

  public async connect(): Promise<void> {
    const maxRetries = 3
    let retryCount = 0

    while (retryCount < maxRetries)
      try {
        await this.client.connect()
        this.db = this.client.db('contract-deployments')
        const collectionName = this.environment
        this.collection = this.db.collection<IDeploymentRecord>(collectionName)

        // Create indexes on first connection
        await this.createIndexes()
        consola.info(`Connected to MongoDB collection: ${collectionName}`)
        return
      } catch (error) {
        retryCount++
        if (retryCount === maxRetries) {
          consola.error('Failed to connect to MongoDB after retries:', error)
          throw error
        }

        const delay = Math.pow(2, retryCount) * 1000 // Exponential backoff
        consola.warn(`MongoDB connection failed, retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
  }

  private async createIndexes(): Promise<void> {
    const indexes = [
      { contractName: 1, network: 1, version: 1 },
      { contractNetworkKey: 1, version: 1 },
      { timestamp: -1 },
      { address: 1 },
    ]

    for (const index of indexes)
      try {
        await this.collection.createIndex(index)
      } catch (error) {
        consola.warn('Index creation failed (may already exist):', error)
      }
  }

  // Type guard for validating raw deployment data
  private isValidDeploymentData(data: unknown): data is IRawDeploymentData {
    if (typeof data !== 'object' || data === null) 
      return false
    

    const deployment = data as Record<string, unknown>

    // Check required fields exist and are strings
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
      
    

    // SALT is optional but must be string if present
    if (deployment.SALT !== undefined && typeof deployment.SALT !== 'string') 
      return false
    

    // Validate timestamp format
    const timestamp = deployment.TIMESTAMP as string
    if (isNaN(Date.parse(timestamp))) 
      return false
    

    // Validate verified field
    const verified = deployment.VERIFIED as string
    if (verified !== 'true' && verified !== 'false') 
      return false
    

    return true
  }

  // Type guard for validating JSON data structure
  private isValidJsonStructure(data: unknown): data is IJsonDataStructure {
    if (typeof data !== 'object' || data === null) 
      return false
    

    // Basic structure validation - we'll do deeper validation during iteration
    return true
  }

  // Data validation for final deployment record
  private validateRecord(record: IDeploymentRecord): boolean {
    const required = ['contractName', 'network', 'version', 'address']
    return required.every((field) => record[field as keyof IDeploymentRecord])
  }

  public transformLogData(jsonData: unknown): IDeploymentRecord[] {
    const records: IDeploymentRecord[] = []

    // Validate the overall structure
    if (!this.isValidJsonStructure(jsonData)) {
      consola.error('Invalid JSON data structure provided')
      return records
    }

    const typedJsonData = jsonData as IJsonDataStructure

    // Iterate through contracts
    // Iterate through networks
    // Iterate through environments - only process the target environment
    for (const [contractName, contractData] of Object.entries(typedJsonData)) {
      if (typeof contractData !== 'object' || contractData === null) {
        consola.warn(`Skipping invalid contract data for: ${contractName}`)
        continue
      }

      for (const [network, networkData] of Object.entries(contractData)) {
        if (typeof networkData !== 'object' || networkData === null) {
          consola.warn(
            `Skipping invalid network data for: ${contractName}.${network}`
          )
          continue
        }

        for (const [environment, envData] of Object.entries(networkData)) {
          // Skip environments that don't match our target environment
          if (environment !== this.environment) continue

          if (typeof envData !== 'object' || envData === null) {
            consola.warn(
              `Skipping invalid environment data for: ${contractName}.${network}.${environment}`
            )
            continue
          }

          // Iterate through versions
          // Each version contains an array of deployments
          for (const [version, deployments] of Object.entries(envData)) {
            if (!Array.isArray(deployments)) {
              consola.warn(
                `Skipping invalid deployments array for: ${contractName}.${network}.${environment}.${version}`
              )
              continue
            }

            for (const deployment of deployments) {
              // Validate each deployment object before processing
              if (!this.isValidDeploymentData(deployment)) {
                consola.warn(
                  `Skipping invalid deployment data: ${contractName} on ${network} (${environment}) v${version}`
                )
                continue
              }

              // Now we can safely access properties with type safety
              const typedDeployment = deployment as IRawDeploymentData

              try {
                const record: IDeploymentRecord = {
                  contractName,
                  network,
                  version,
                  address: typedDeployment.ADDRESS,
                  optimizerRuns: typedDeployment.OPTIMIZER_RUNS,
                  timestamp: new Date(typedDeployment.TIMESTAMP),
                  constructorArgs: typedDeployment.CONSTRUCTOR_ARGS,
                  salt: typedDeployment.SALT || undefined,
                  verified: typedDeployment.VERIFIED === 'true',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  contractNetworkKey: `${contractName}-${network}`,
                  contractVersionKey: `${contractName}-${version}`,
                }

                if (this.validateRecord(record)) 
                  records.push(record)
                 else 
                  consola.warn(
                    `Skipping record that failed final validation: ${contractName} on ${network} (${environment})`
                  )
                
              } catch (error) {
                consola.warn(
                  `Error processing deployment record for ${contractName} on ${network} (${environment}): ${error}`
                )
              }
            }
          }
        }
      }
    }

    return records
  }

  public async upsertDeployment(record: IDeploymentRecord): Promise<void> {
    const filter = {
      contractName: record.contractName,
      network: record.network,
      version: record.version,
      address: record.address,
    }

    const update = {
      $set: {
        contractName: record.contractName,
        network: record.network,
        version: record.version,
        address: record.address,
        optimizerRuns: record.optimizerRuns,
        timestamp: record.timestamp,
        constructorArgs: record.constructorArgs,
        salt: record.salt,
        verified: record.verified,
        contractNetworkKey: record.contractNetworkKey,
        contractVersionKey: record.contractVersionKey,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    }

    await this.collection.updateOne(filter, update, { upsert: true })
  }

  public async batchUpsertDeployments(
    records: IDeploymentRecord[]
  ): Promise<void> {
    if (records.length === 0) return

    const operations = records.map((record) => ({
      updateOne: {
        filter: {
          contractName: record.contractName,
          network: record.network,
          version: record.version,
          address: record.address,
        },
        update: {
          $set: {
            contractName: record.contractName,
            network: record.network,
            version: record.version,
            address: record.address,
            optimizerRuns: record.optimizerRuns,
            timestamp: record.timestamp,
            constructorArgs: record.constructorArgs,
            salt: record.salt,
            verified: record.verified,
            contractNetworkKey: record.contractNetworkKey,
            contractVersionKey: record.contractVersionKey,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    }))

    await this.collection.bulkWrite(operations)
  }

  public async syncDeployments(): Promise<void> {
    try {
      consola.info('Reading deployment log file...')
      const jsonData = JSON.parse(readFileSync(this.config.logFilePath, 'utf8'))

      consola.info('Transforming data...')
      const records = this.transformLogData(jsonData)

      consola.info(`Found ${records.length} deployment records in JSON file`)

      // Get existing records from MongoDB for comparison
      consola.info('Fetching existing records from MongoDB...')
      const existingRecords = await this.collection.find({}).toArray()
      consola.info(
        `Found ${existingRecords.length} existing records in MongoDB`
      )

      // Create maps for efficient comparison
      const jsonRecordsMap = new Map<string, IDeploymentRecord>()
      const mongoRecordsMap = new Map<string, IDeploymentRecord>()

      // Create unique keys for comparison (contract-network-version-address)
      records.forEach((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        jsonRecordsMap.set(key, record)
      })

      existingRecords.forEach((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        mongoRecordsMap.set(key, record)
      })

      // Find records to add (in JSON but not in MongoDB)
      const recordsToAdd = records.filter((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        return !mongoRecordsMap.has(key)
      })

      // Find records to remove (in MongoDB but not in JSON) - for complete sync
      const recordsToRemove = existingRecords.filter((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        return !jsonRecordsMap.has(key)
      })

      consola.info(`Records to add: ${recordsToAdd.length}`)
      consola.info(`Records to remove: ${recordsToRemove.length}`)

      // Add new records
      if (recordsToAdd.length > 0) {
        consola.info('Adding new records...')
        for (let i = 0; i < recordsToAdd.length; i += this.config.batchSize) {
          const batch = recordsToAdd.slice(i, i + this.config.batchSize)
          await this.batchUpsertDeployments(batch)
          consola.info(
            `Added batch ${
              Math.floor(i / this.config.batchSize) + 1
            }/${Math.ceil(recordsToAdd.length / this.config.batchSize)}`
          )
        }
      }

      // Remove records not in JSON (to ensure MongoDB matches JSON exactly)
      if (recordsToRemove.length > 0) {
        consola.warn(
          `Removing ${recordsToRemove.length} records that are not in JSON file...`
        )
        for (const record of recordsToRemove)
          await this.collection.deleteOne({
            contractName: record.contractName,
            network: record.network,
            version: record.version,
            address: record.address,
          })

        consola.info('Removed obsolete records')
      }

      consola.success('Sync completed - MongoDB now matches JSON file exactly')
    } catch (error) {
      consola.error('Sync failed, but deployment can continue:', error)
      // Don't throw - allow deployment process to continue
    }
  }

  public async updateDeployment(
    contractName: string,
    network: string,
    version: string,
    address: string,
    updates: Partial<IDeploymentRecord>
  ): Promise<void> {
    const filter = {
      contractName,
      network,
      version,
      address,
    }

    const updateDoc = {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
    }

    const result = await this.collection.updateOne(filter, updateDoc)

    if (result.matchedCount === 0)
      throw new Error(
        `No deployment found matching: ${contractName} on ${network} v${version} at ${address}`
      )

    consola.success(`Updated deployment: ${contractName} on ${network}`)
  }

  public async queryDeployments(
    filters: Partial<IDeploymentRecord>
  ): Promise<IDeploymentRecord[]> {
    return this.collection.find(filters).toArray()
  }

  public async getLatestDeployment(
    contractName: string,
    network: string
  ): Promise<IDeploymentRecord | null> {
    return this.collection.findOne(
      { contractName, network },
      { sort: { timestamp: -1 } }
    )
  }

  public async disconnect(): Promise<void> {
    await this.client.close()
  }
}

// Define sync command
const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description:
      'Sync MongoDB to match the local JSON file exactly (temporary migration feature)',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment (staging or production)',
      default: 'production',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    const manager = new DeploymentLogManager(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await manager.connect()
      consola.info('Syncing MongoDB to match local JSON file...')
      consola.warn(
        'This is a temporary migration feature - the local JSON file will be deprecated'
      )
      await manager.syncDeployments()
    } catch (error) {
      consola.error('Sync failed:', error)
      process.exit(1)
    } finally {
      await manager.disconnect()
    }
  },
})

// Define add command
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Add single deployment record to MongoDB',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment (staging or production)',
      default: 'production',
    },
    contract: {
      type: 'string',
      description: 'Contract name',
      required: true,
    },
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    version: {
      type: 'string',
      description: 'Contract version',
      required: true,
    },
    address: {
      type: 'string',
      description: 'Contract address',
      required: true,
    },
    'optimizer-runs': {
      type: 'string',
      description: 'Optimizer runs',
      required: true,
    },
    timestamp: {
      type: 'string',
      description: 'Deployment timestamp',
      required: true,
    },
    'constructor-args': {
      type: 'string',
      description: 'Constructor arguments',
      required: true,
    },
    verified: {
      type: 'string',
      description: 'Verification status (true or false)',
      required: true,
    },
    salt: {
      type: 'string',
      description: 'Salt value (optional)',
      required: false,
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate verified
    if (args.verified !== 'true' && args.verified !== 'false') {
      consola.error('Verified must be either "true" or "false"')
      process.exit(1)
    }

    // Create deployment record
    const record: IDeploymentRecord = {
      contractName: args.contract,
      network: args.network,

      version: args.version,
      address: args.address,
      optimizerRuns: args['optimizer-runs'],
      timestamp: new Date(args.timestamp),
      constructorArgs: args['constructor-args'],
      salt: args.salt || undefined,
      verified: args.verified === 'true',
      createdAt: new Date(),
      updatedAt: new Date(),
      contractNetworkKey: `${args.contract}-${args.network}`,
      contractVersionKey: `${args.contract}-${args.version}`,
    }

    const manager = new DeploymentLogManager(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await manager.connect()
      consola.info(
        `Adding deployment record: ${args.contract} on ${args.network}`
      )
      await manager.upsertDeployment(record)
      consola.success(
        `Successfully added/updated deployment: ${args.contract} on ${args.network}`
      )
    } catch (error) {
      consola.error('Add operation failed:', error)
      process.exit(1)
    } finally {
      await manager.disconnect()
    }
  },
})

// Define update command
const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description: 'Update specific fields of an existing deployment record',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment (staging or production)',
      default: 'production',
    },
    contract: {
      type: 'string',
      description: 'Contract name',
      required: true,
    },
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    version: {
      type: 'string',
      description: 'Contract version',
      required: true,
    },
    address: {
      type: 'string',
      description: 'Contract address',
      required: true,
    },
    // Optional update fields
    'optimizer-runs': {
      type: 'string',
      description: 'Update optimizer runs',
      required: false,
    },
    'constructor-args': {
      type: 'string',
      description: 'Update constructor arguments',
      required: false,
    },
    verified: {
      type: 'string',
      description: 'Update verification status (true or false)',
      required: false,
    },
    salt: {
      type: 'string',
      description: 'Update salt value',
      required: false,
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate verified if provided
    if (
      args.verified &&
      args.verified !== 'true' &&
      args.verified !== 'false'
    ) {
      consola.error('Verified must be either "true" or "false"')
      process.exit(1)
    }

    // Build updates object with only provided fields
    const updates: Partial<IDeploymentRecord> = {}
    if (args['optimizer-runs']) updates.optimizerRuns = args['optimizer-runs']
    if (args['constructor-args'])
      updates.constructorArgs = args['constructor-args']
    if (args.verified) updates.verified = args.verified === 'true'
    if (args.salt !== undefined) updates.salt = args.salt || undefined

    if (Object.keys(updates).length === 0) {
      consola.error(
        'No update fields provided. Specify at least one field to update.'
      )
      process.exit(1)
    }

    const manager = new DeploymentLogManager(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await manager.connect()
      consola.info(`Updating deployment: ${args.contract} on ${args.network}`)
      await manager.updateDeployment(
        args.contract,
        args.network,
        args.version,
        args.address,
        updates
      )
    } catch (error) {
      consola.error('Update operation failed:', error)
      process.exit(1)
    } finally {
      await manager.disconnect()
    }
  },
})

// Main command with subcommands
const main = defineCommand({
  meta: {
    name: 'update-deployment-logs',
    description:
      'MongoDB Deployment Logs CLI - Add, update, and sync deployment logs',
    version: '1.0.0',
  },
  subCommands: {
    sync: syncCommand,
    add: addCommand,
    update: updateCommand,
  },
})

// Run the CLI
runMain(main)

export { DeploymentLogManager, IDeploymentRecord }
