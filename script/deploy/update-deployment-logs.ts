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
import {
  type Db,
  type Collection,
  type ObjectId,
  type IndexSpecification,
  MongoClient,
} from 'mongodb'

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
  solcVersion?: string
  evmVersion?: string
  zkSolcVersion?: string

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
  SOLC_VERSION?: string
  EVM_VERSION?: string
  ZK_SOLC_VERSION?: string
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
  databaseName: string
}

// Configuration setup
const config: IConfig = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  logFilePath: path.join(
    process.cwd(),
    'deployments/_deployments_log_file.json'
  ),
  batchSize: 100,
  databaseName: 'contract-deployments',
}

class DeploymentLogManager {
  private client: MongoClient
  private db: Db | undefined
  private collection: Collection<IDeploymentRecord> | undefined

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
        this.db = this.client.db(config.databaseName)
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
    if (!this.collection) {
      consola.error('Collection not initialized')
      return
    }

    const indexSpecs = [
      {
        key: { contractName: 1, network: 1, version: 1 } as IndexSpecification,
        name: 'contract_network_version',
      },
      {
        key: { contractNetworkKey: 1, version: 1 } as IndexSpecification,
        name: 'contract_network_key_version',
      },
      { key: { timestamp: -1 } as IndexSpecification, name: 'timestamp_desc' },
      { key: { address: 1 } as IndexSpecification, name: 'address' },
    ]

    try {
      const existingIndexes = await this.collection.listIndexes().toArray()
      const existingIndexNames = new Set(existingIndexes.map((idx) => idx.name))

      for (const indexSpec of indexSpecs)
        if (!existingIndexNames.has(indexSpec.name))
          try {
            await this.collection.createIndex(indexSpec.key, {
              name: indexSpec.name,
            })
            consola.info(`Created index: ${indexSpec.name}`)
          } catch (error) {
            consola.warn(`Failed to create index ${indexSpec.name}:`, error)
          }
        else consola.debug(`Index ${indexSpec.name} already exists`)
    } catch (error) {
      consola.warn('Failed to list existing indexes:', error)
    }
  }

  // Enhanced timestamp validation
  private isValidTimestamp(timestamp: string): boolean {
    if (!timestamp || typeof timestamp !== 'string') return false

    // Check for common invalid formats that Date.parse() might accept
    if (timestamp.trim() === '' || timestamp === 'Invalid Date') return false

    // Try to parse the date
    const parsedDate = new Date(timestamp)

    // Check if the date is valid and not NaN
    if (isNaN(parsedDate.getTime())) return false

    // Check if the date is reasonable (not too far in past/future)
    const now = new Date()
    const minDate = new Date('2020-01-01') // Reasonable minimum for blockchain deployments
    const maxDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) // 1 year in future

    return parsedDate >= minDate && parsedDate <= maxDate
  }

  // Type guard for validating raw deployment data
  private isValidDeploymentData(data: unknown): data is IRawDeploymentData {
    if (typeof data !== 'object' || data === null) return false

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

    // Validate timestamp format with stricter validation
    const timestamp = deployment.TIMESTAMP as string
    if (!this.isValidTimestamp(timestamp)) return false

    // Validate verified field
    const verified = deployment.VERIFIED as string
    if (verified !== 'true' && verified !== 'false') return false

    return true
  }

  // Type guard for validating JSON data structure
  private isValidJsonStructure(data: unknown): data is IJsonDataStructure {
    if (typeof data !== 'object' || data === null) return false

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
                  solcVersion: typedDeployment.SOLC_VERSION,
                  evmVersion: typedDeployment.EVM_VERSION,
                  zkSolcVersion: typedDeployment.ZK_SOLC_VERSION,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  contractNetworkKey: `${contractName}-${network}`,
                  contractVersionKey: `${contractName}-${version}`,
                }

                if (this.validateRecord(record)) records.push(record)
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
    if (!this.collection) throw new Error('Collection not initialized')

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
        solcVersion: record.solcVersion,
        evmVersion: record.evmVersion,
        zkSolcVersion: record.zkSolcVersion,
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

    if (!this.collection) throw new Error('Collection not initialized')

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
            solcVersion: record.solcVersion,
            evmVersion: record.evmVersion,
            zkSolcVersion: record.zkSolcVersion,
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

    try {
      const result = await this.collection.bulkWrite(operations, {
        ordered: false,
      })

      if (result.hasWriteErrors()) {
        const writeErrors = result.getWriteErrors()
        consola.warn(
          `Batch operation completed with ${writeErrors.length} errors:`
        )
        writeErrors.forEach((error) => {
          const record = records[error.index]
          if (record)
            consola.warn(
              `Failed to upsert ${record.contractName} on ${record.network}: ${error.errmsg}`
            )
        })
      }

      consola.info(
        `Batch upsert completed: ${result.upsertedCount} inserted, ${result.modifiedCount} modified`
      )
    } catch (error) {
      consola.error('Batch upsert operation failed:', error)
      throw error
    }
  }

  public async syncDeployments(): Promise<void> {
    if (!this.collection) throw new Error('Collection not initialized')

    try {
      consola.info('Reading deployment log file...')
      const jsonData = JSON.parse(readFileSync(this.config.logFilePath, 'utf8'))

      consola.info('Transforming data...')
      const records = this.transformLogData(jsonData)

      consola.info(`Found ${records.length} deployment records in JSON file`)

      // Use aggregation pipeline to get only the keys we need for comparison
      consola.info('Fetching existing record keys from MongoDB...')
      const existingKeys = await this.collection
        .aggregate([
          {
            $project: {
              _id: 0,
              key: {
                $concat: [
                  '$contractName',
                  '-',
                  '$network',
                  '-',
                  '$version',
                  '-',
                  '$address',
                ],
              },
              contractName: 1,
              network: 1,
              version: 1,
              address: 1,
            },
          },
        ])
        .toArray()

      consola.info(`Found ${existingKeys.length} existing records in MongoDB`)

      // Create sets for efficient comparison
      const jsonKeysSet = new Set<string>()
      const mongoKeysSet = new Set<string>()
      const mongoKeysMap = new Map<
        string,
        {
          contractName: string
          network: string
          version: string
          address: string
        }
      >()

      // Create unique keys for comparison
      records.forEach((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        jsonKeysSet.add(key)
      })

      existingKeys.forEach((item) => {
        mongoKeysSet.add(item.key)
        mongoKeysMap.set(item.key, {
          contractName: item.contractName,
          network: item.network,
          version: item.version,
          address: item.address,
        })
      })

      // Find records to add (in JSON but not in MongoDB)
      const recordsToAdd = records.filter((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        return !mongoKeysSet.has(key)
      })

      // Find keys to remove (in MongoDB but not in JSON)
      const keysToRemove = Array.from(mongoKeysSet).filter(
        (key) => !jsonKeysSet.has(key)
      )

      consola.info(`Records to add: ${recordsToAdd.length}`)
      consola.info(`Records to remove: ${keysToRemove.length}`)

      // Add new records in batches
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

      // Remove records not in JSON using bulk operations
      if (keysToRemove.length > 0) {
        consola.warn(
          `Removing ${keysToRemove.length} records that are not in JSON file...`
        )

        const deleteOperations = keysToRemove
          .map((key) => {
            const record = mongoKeysMap.get(key)
            if (!record) {
              consola.warn(
                `Skipping deletion - record not found for key: ${key}`
              )
              return null
            }

            return {
              deleteOne: {
                filter: {
                  contractName: record.contractName,
                  network: record.network,
                  version: record.version,
                  address: record.address,
                },
              },
            }
          })
          .filter((op) => op !== null)

        // Process deletions in batches
        for (
          let i = 0;
          i < deleteOperations.length;
          i += this.config.batchSize
        ) {
          const batch = deleteOperations.slice(i, i + this.config.batchSize)
          await this.collection.bulkWrite(batch)
        }

        consola.info('Removed obsolete records')
      }

      consola.success('Sync completed - MongoDB now matches JSON file exactly')
    } catch (error) {
      consola.error('Sync failed, but deployment can continue:', error)
    }
  }

  public async updateDeployment(
    contractName: string,
    network: string,
    version: string,
    address: string,
    updates: Partial<IDeploymentRecord>
  ): Promise<void> {
    if (!this.collection) throw new Error('Collection not initialized')

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
    if (!this.collection) throw new Error('Collection not initialized')

    return this.collection.find(filters).toArray()
  }

  public async getLatestDeployment(
    contractName: string,
    network: string
  ): Promise<IDeploymentRecord | null> {
    if (!this.collection) throw new Error('Collection not initialized')

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
    'solc-version': {
      type: 'string',
      description: 'Solidity compiler version',
      required: false,
    },
    'evm-version': {
      type: 'string',
      description: 'EVM version',
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
      solcVersion: args['solc-version'],
      evmVersion: args['evm-version'],
      zkSolcVersion:
        typeof args['zk-solc-version'] === 'string'
          ? args['zk-solc-version']
          : undefined,
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
    'solc-version': {
      type: 'string',
      description: 'Solidity compiler version',
      required: false,
    },
    'evm-version': {
      type: 'string',
      description: 'EVM version',
      required: false,
    },
    'zk-solc-version': {
      type: 'string',
      description: 'ZK Solidity compiler version',
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
    if (args['optimizer-runs'])
      updates.optimizerRuns =
        typeof args['optimizer-runs'] === 'string'
          ? args['optimizer-runs']
          : undefined
    if (args['constructor-args'])
      updates.constructorArgs =
        typeof args['constructor-args'] === 'string'
          ? args['constructor-args']
          : undefined
    if (args.verified) updates.verified = args.verified === 'true'
    if (args.salt !== undefined)
      updates.salt =
        typeof args.salt === 'string' ? args.salt || undefined : undefined
    if (args['solc-version'])
      updates.solcVersion =
        typeof args['solc-version'] === 'string'
          ? args['solc-version']
          : undefined
    if (args['evm-version'])
      updates.evmVersion =
        typeof args['evm-version'] === 'string'
          ? args['evm-version']
          : undefined
    if (args['zk-solc-version'])
      updates.zkSolcVersion =
        typeof args['zk-solc-version'] === 'string'
          ? args['zk-solc-version']
          : undefined

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
