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
import { createInterface } from 'readline'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  type Collection,
  type Db,
  type IndexSpecification,
  MongoClient,
} from 'mongodb'

import type { EnvironmentEnum } from '../common/types'
import { getEnvVar } from '../demoScripts/utils/demoScriptHelpers'
import { sleep } from '../utils/delay'

import { createDefaultCache } from './shared/deployment-cache'
import {
  type IDeploymentRecord,
  type IUpdateConfig,
  RecordTransformer,
} from './shared/mongo-log-utils'

// Interface for index specifications with old names
interface IIndexSpec {
  key: IndexSpecification
  name: string
  oldNames?: string[]
}

// Configuration setup
const config: IUpdateConfig = {
  mongoUri: getEnvVar('MONGODB_URI'),
  logFilePath: path.join(
    process.cwd(),
    'deployments/_deployments_log_file.json'
  ),
  batchSize: 100,
  databaseName: 'contract-deployments',
}

/** Invalidate deployment cache for an environment after writing to MongoDB */
async function invalidateDeploymentCache(
  environment: keyof typeof EnvironmentEnum
): Promise<void> {
  const cache = createDefaultCache({
    mongoUri: config.mongoUri,
    batchSize: config.batchSize,
    databaseName: config.databaseName,
  })
  await cache.invalidate(environment)
}

// Helper function for user confirmation
async function getUserConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'yes')
    })
  })
}

class DeploymentLogManager {
  private client: MongoClient
  private db: Db | undefined
  private collection: Collection<IDeploymentRecord> | undefined

  public constructor(
    private config: IUpdateConfig,
    private environment: keyof typeof EnvironmentEnum
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
        await sleep(delay)
      }
  }

  public async createIndexes(): Promise<void> {
    if (!this.collection) {
      consola.error('Collection not initialized')
      return
    }

    const indexSpecs: IIndexSpec[] = [
      {
        key: { contractName: 1, network: 1, version: 1 } as IndexSpecification,
        name: 'contract_network_version',
        oldNames: ['contractName_1_network_1_version_1'], // Known old name
      },
      {
        key: { contractNetworkKey: 1, version: 1 } as IndexSpecification,
        name: 'contract_network_key_version',
        oldNames: ['contractNetworkKey_1_version_1'], // Known old name
      },
      {
        key: { timestamp: -1 } as IndexSpecification,
        name: 'timestamp_desc',
        oldNames: ['timestamp_-1'], // Known old name
      },
      {
        key: { address: 1 } as IndexSpecification,
        name: 'address',
        oldNames: ['address_1'], // Known old name
      },
    ]
    try {
      const existingIndexes = await this.collection.listIndexes().toArray()
      const existingIndexNames = new Set(existingIndexes.map((idx) => idx.name))

      for (const indexSpec of indexSpecs) {
        // Check if we need to drop old indexes
        if (indexSpec.oldNames)
          for (const oldName of indexSpec.oldNames)
            if (existingIndexNames.has(oldName))
              try {
                await this.collection.dropIndex(oldName)
                consola.info(`Dropped old index: ${oldName}`)
              } catch (error) {
                consola.warn(`Failed to drop old index ${oldName}:`, error)
              }

        // Create the new index if it doesn't exist
        if (!existingIndexNames.has(indexSpec.name))
          try {
            await this.collection.createIndex(indexSpec.key, {
              name: indexSpec.name,
            })
            consola.info(`Created index: ${indexSpec.name}`)
          } catch (error: any) {
            // If it fails due to duplicate key pattern, that's okay
            if (error.code === 85 || error.message?.includes('already exists'))
              consola.debug(
                `Index with same key pattern as ${indexSpec.name} already exists`
              )
            else
              consola.warn(`Failed to create index ${indexSpec.name}:`, error)
          }
        else consola.debug(`Index ${indexSpec.name} already exists`)
      }
    } catch (error) {
      consola.warn('Failed to manage indexes:', error)
    }
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
            // Convert undefined to "" so MongoDB overwrites existing values
            // JSON is the source of truth - if field is missing, clear it to empty string
            salt: record.salt ?? '',
            verified: record.verified,
            solcVersion: record.solcVersion ?? '',
            evmVersion: record.evmVersion ?? '',
            zkSolcVersion: record.zkSolcVersion ?? '',
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

  public async syncDeployments(
    mode: 'merge' | 'overwrite' = 'merge'
  ): Promise<void> {
    if (!this.collection) throw new Error('Collection not initialized')

    try {
      consola.info('Reading deployment log file...')
      const jsonData = JSON.parse(readFileSync(this.config.logFilePath, 'utf8'))

      consola.info('Transforming data...')
      const records = RecordTransformer.processJsonData(
        jsonData,
        this.environment,
        {
          onSkip: (msg) => consola.warn(msg),
        }
      )

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

      // Find records to update (exist in both - update MongoDB with JSON values)
      const recordsToUpdate = records.filter((record) => {
        const key = `${record.contractName}-${record.network}-${record.version}-${record.address}`
        return mongoKeysSet.has(key)
      })

      // Find keys to remove (in MongoDB but not in JSON)
      const keysToRemove = Array.from(mongoKeysSet).filter(
        (key) => !jsonKeysSet.has(key)
      )

      consola.info(`Records to add: ${recordsToAdd.length}`)
      consola.info(`Records to update: ${recordsToUpdate.length}`)
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

      // Update existing records in batches (MongoDB takes values from JSON)
      if (recordsToUpdate.length > 0) {
        consola.info('Updating existing records with JSON values...')
        for (
          let i = 0;
          i < recordsToUpdate.length;
          i += this.config.batchSize
        ) {
          const batch = recordsToUpdate.slice(i, i + this.config.batchSize)
          await this.batchUpsertDeployments(batch)
          consola.info(
            `Updated batch ${
              Math.floor(i / this.config.batchSize) + 1
            }/${Math.ceil(recordsToUpdate.length / this.config.batchSize)}`
          )
        }
      }

      // Remove records not in JSON using bulk operations (only in overwrite mode)
      if (keysToRemove.length > 0 && mode === 'overwrite') {
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
        consola.success(
          'Sync completed - MongoDB now matches JSON file exactly'
        )
      } else if (keysToRemove.length > 0) {
        consola.info(
          `Merge mode: Skipping deletion of ${keysToRemove.length} records not in local JSON`
        )
        consola.info(
          'These records exist in MongoDB (possibly from other developers)'
        )
        consola.success(
          'Sync completed - Added new records, updated existing records, preserved extra MongoDB records'
        )
      } else {
        consola.success(
          'Sync completed - MongoDB is up to date (added/updated records as needed)'
        )
      }
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
      'Sync MongoDB with local JSON file. Use merge mode (default) to safely add entries without deletion.',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment (staging or production)',
      default: 'production',
    },
    mode: {
      type: 'string',
      description:
        'Sync mode: merge (safe, default) or overwrite (dangerous, deletes missing entries)',
      default: 'merge',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate mode
    if (args.mode !== 'merge' && args.mode !== 'overwrite') {
      consola.error('Mode must be either "merge" or "overwrite"')
      consola.info(
        'Use "merge" to safely add entries without deleting existing ones'
      )
      consola.info(
        'Use "overwrite" to make MongoDB match local JSON exactly (deletes missing entries)'
      )
      process.exit(1)
    }

    const manager = new DeploymentLogManager(
      config,
      args.env as keyof typeof EnvironmentEnum
    )

    let exitCode = 0
    let shouldSync = true
    try {
      await manager.connect()

      if (args.mode === 'merge') {
        consola.info(
          'Syncing in MERGE mode (safe - will not delete MongoDB entries)'
        )
        consola.info(
          'This will add entries from JSON that are missing in MongoDB'
        )
      } else {
        consola.warn(
          'Syncing in OVERWRITE mode (DANGEROUS - will delete MongoDB entries not in JSON)'
        )
        consola.warn(
          'Use this mode only if you are certain your local JSON is the complete source of truth'
        )

        // Require confirmation for overwrite mode
        const confirmed = await getUserConfirmation(
          'Are you sure you want to delete MongoDB entries not in your local JSON? (yes/no): '
        )
        if (!confirmed) {
          consola.info('Sync cancelled')
          shouldSync = false
        }
      }

      if (shouldSync) {
        await manager.syncDeployments(args.mode as 'merge' | 'overwrite')
        await invalidateDeploymentCache(
          args.env as keyof typeof EnvironmentEnum
        )
      }
    } catch (error) {
      consola.error('Sync failed:', error)
      exitCode = 1
    } finally {
      await manager.disconnect()
    }
    if (exitCode !== 0) process.exit(exitCode)
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
      salt: args.salt || '',
      verified: args.verified === 'true',
      solcVersion: args['solc-version'] || '',
      evmVersion: args['evm-version'] || '',
      zkSolcVersion:
        typeof args['zk-solc-version'] === 'string'
          ? args['zk-solc-version']
          : '',
      createdAt: new Date(),
      updatedAt: new Date(),
      contractNetworkKey: `${args.contract}-${args.network}`,
      contractVersionKey: `${args.contract}-${args.version}`,
    }

    const manager = new DeploymentLogManager(
      config,
      args.env as keyof typeof EnvironmentEnum
    )

    let exitCode = 0
    try {
      await manager.connect()
      consola.info(
        `Adding deployment record: ${args.contract} on ${args.network}`
      )
      await manager.upsertDeployment(record)
      await invalidateDeploymentCache(args.env as keyof typeof EnvironmentEnum)
      consola.success(
        `Successfully added/updated deployment: ${args.contract} on ${args.network}`
      )
    } catch (error) {
      consola.error('Add operation failed:', error)
      exitCode = 1
    } finally {
      await manager.disconnect()
    }
    if (exitCode !== 0) process.exit(exitCode)
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
      args.env as keyof typeof EnvironmentEnum
    )

    let exitCode = 0
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
      await invalidateDeploymentCache(args.env as keyof typeof EnvironmentEnum)
    } catch (error) {
      consola.error('Update operation failed:', error)
      exitCode = 1
    } finally {
      await manager.disconnect()
    }
    if (exitCode !== 0) process.exit(exitCode)
  },
})

// Define create-indexes command
const createIndexesCommand = defineCommand({
  meta: {
    name: 'create-indexes',
    description: 'Create or update MongoDB indexes for deployment collections',
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
      args.env as keyof typeof EnvironmentEnum
    )

    let exitCode = 0
    try {
      await manager.connect()
      consola.info('Creating/updating indexes...')
      await manager.createIndexes()
      consola.success('Indexes created/updated successfully')
    } catch (error) {
      consola.error('Failed to create indexes:', error)
      exitCode = 1
    } finally {
      await manager.disconnect()
    }
    if (exitCode !== 0) process.exit(exitCode)
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
    'create-indexes': createIndexesCommand,
  },
})

// Run the CLI
runMain(main)

export { DeploymentLogManager, IDeploymentRecord }
