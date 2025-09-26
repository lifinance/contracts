#!/usr/bin/env bun

/**
 * Query Deployment Logs
 *
 * This script provides various query operations for deployment logs stored in MongoDB.
 * It supports listing, filtering, searching, and retrieving deployment records from
 * both production and staging environments with comprehensive CLI commands.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient, type Db, type Collection, type ObjectId } from 'mongodb'

import type { EnvironmentEnum } from '../common/types'

import { ValidationUtils } from './shared/mongo-log-utils'

// Reuse the same DeploymentRecord interface
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
  createdAt: Date
  updatedAt: Date
  contractNetworkKey: string
  contractVersionKey: string
}

interface IConfig {
  mongoUri: string
  batchSize: number
  databaseName: string
}

const config: IConfig = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  batchSize: 100,
  databaseName: 'contract-deployments',
}

class DeploymentLogQuerier {
  private client: MongoClient
  private db!: Db
  private collection!: Collection<IDeploymentRecord>

  public constructor(
    private config: IConfig,
    private environment: keyof typeof EnvironmentEnum
  ) {
    this.client = new MongoClient(this.config.mongoUri)
  }

  public async connect(): Promise<void> {
    try {
      await this.client.connect()
      this.db = this.client.db(this.config.databaseName)
      const collectionName = this.environment
      this.collection = this.db.collection<IDeploymentRecord>(collectionName)
    } catch (error) {
      consola.error('Failed to connect to MongoDB:', error)
      throw error
    }
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
    const filter: Record<string, unknown> = {}
    if (contractName) filter.contractName = contractName
    if (network) filter.network = network

    const skip = (page - 1) * limit
    const total = await this.collection.countDocuments(filter)
    const totalPages = Math.ceil(total / limit)

    const data = await this.collection
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()

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

  public async findByAddress(
    address: string
  ): Promise<IDeploymentRecord | null> {
    return this.collection.findOne({ address })
  }

  public async filterDeployments(filters: {
    contractName?: string
    network?: string
    version?: string
    verified?: boolean
    limit?: number
  }): Promise<IDeploymentRecord[]> {
    const query: Record<string, unknown> = {}

    if (filters.contractName) query.contractName = filters.contractName
    if (filters.network) query.network = filters.network
    if (filters.version) query.version = filters.version
    if (filters.verified !== undefined) query.verified = filters.verified

    return this.collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(filters.limit || 50)
      .toArray()
  }

  public async getDeploymentHistory(
    contractName: string,
    network: string
  ): Promise<IDeploymentRecord[]> {
    return this.collection
      .find({ contractName, network })
      .sort({ timestamp: -1 })
      .toArray()
  }

  public async disconnect(): Promise<void> {
    await this.client.close()
  }
}

// Helper function to format deployment record for display
function formatDeployment(deployment: IDeploymentRecord): string {
  return `
Contract: ${deployment.contractName}
Network: ${deployment.network}
Version: ${deployment.version}
Address: ${deployment.address}
Timestamp: ${deployment.timestamp.toISOString()}
Created: ${deployment.createdAt.toISOString()}
Updated: ${deployment.updatedAt.toISOString()}
Verified: ${deployment.verified}
Optimizer Runs: ${deployment.optimizerRuns}
${deployment.salt ? `Salt: ${deployment.salt}` : ''}
---`
}

// Helper function to output JSON without logging
function outputJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

// Define latest command
const latestCommand = defineCommand({
  meta: {
    name: 'latest',
    description: 'Get latest deployment for a contract on a network',
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
    format: {
      type: 'string',
      description: 'Output format (json or table)',
      default: 'json',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate format
    if (args.format !== 'json' && args.format !== 'table') {
      consola.error('Format must be either "json" or "table"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await querier.connect()
      const deployment = await querier.getLatestDeployment(
        args.contract,
        args.network
      )

      if (deployment)
        if (args.format === 'table') console.log(formatDeployment(deployment))
        else outputJSON(deployment)
      else {
        await querier.disconnect()
        process.exit(1)
      }
    } catch (error) {
      consola.error('Query failed:', error)
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Define list command
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List deployments with optional filters',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment (staging or production)',
      default: 'production',
    },
    contract: {
      type: 'string',
      description: 'Contract name (optional)',
      required: false,
    },
    network: {
      type: 'string',
      description: 'Network name (optional)',
      required: false,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results (default: 50)',
      required: false,
    },
    page: {
      type: 'string',
      description: 'Page number (default: 1)',
      required: false,
    },
    format: {
      type: 'string',
      description: 'Output format (json or table)',
      default: 'json',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate format
    if (args.format !== 'json' && args.format !== 'table') {
      consola.error('Format must be either "json" or "table"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )
    const limit = ValidationUtils.safeParseInt(args.limit, 50, 1, 1000)
    const page = ValidationUtils.safeParseInt(args.page, 1, 1)

    try {
      await querier.connect()
      const result = await querier.listDeployments(
        args.contract,
        args.network,
        limit,
        page
      )

      if (result.data.length > 0)
        if (args.format === 'table') {
          consola.success(
            `Found ${result.data.length} deployment(s) (Page ${result.pagination.page} of ${result.pagination.totalPages}, Total: ${result.pagination.total}):`
          )
          result.data.forEach((deployment) => {
            console.log(formatDeployment(deployment))
          })

          if (result.pagination.hasNext)
            consola.info(
              `Use --page ${result.pagination.page + 1} to see more results`
            )
        } else
          outputJSON({
            data: result.data,
            pagination: result.pagination,
          })
      else if (args.format === 'table')
        consola.warn('No deployments found matching criteria')
      else
        outputJSON({
          data: [],
          pagination: result.pagination,
        })
    } catch (error) {
      consola.error('Query failed:', error)
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Define find command
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description: 'Find deployment by address',
  },
  args: {
    env: {
      type: 'string',
      description: 'Environment (staging or production)',
      default: 'production',
    },
    address: {
      type: 'string',
      description: 'Contract address',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format (json or table)',
      default: 'json',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate format
    if (args.format !== 'json' && args.format !== 'table') {
      consola.error('Format must be either "json" or "table"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await querier.connect()
      const deployment = await querier.findByAddress(args.address)

      if (deployment)
        if (args.format === 'table') console.log(formatDeployment(deployment))
        else outputJSON(deployment)
      else {
        await querier.disconnect()
        process.exit(1)
      }
    } catch (error) {
      consola.error('Query failed:', error)
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Define filter command
const filterCommand = defineCommand({
  meta: {
    name: 'filter',
    description: 'Filter deployments by multiple criteria',
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
      required: false,
    },
    network: {
      type: 'string',
      description: 'Network name',
      required: false,
    },

    version: {
      type: 'string',
      description: 'Contract version',
      required: false,
    },
    verified: {
      type: 'string',
      description: 'Verification status (true or false)',
      required: false,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results (default: 50)',
      required: false,
    },
    format: {
      type: 'string',
      description: 'Output format (json or table)',
      default: 'json',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate format
    if (args.format !== 'json' && args.format !== 'table') {
      consola.error('Format must be either "json" or "table"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )

    const filters: Record<string, unknown> = {}
    if (args.contract) filters.contractName = args.contract
    if (args.network) filters.network = args.network
    if (args.version) filters.version = args.version
    if (args.verified) filters.verified = args.verified === 'true'
    if (args.limit)
      filters.limit = ValidationUtils.safeParseInt(args.limit, 50, 1, 1000)

    try {
      await querier.connect()
      const deployments = await querier.filterDeployments(filters)

      if (deployments.length > 0)
        if (args.format === 'table') {
          consola.success(`Found ${deployments.length} deployment(s):`)
          deployments.forEach((deployment) => {
            console.log(formatDeployment(deployment))
          })
        } else outputJSON(deployments)
      else if (args.format === 'table')
        consola.warn('No deployments found matching criteria')
      else outputJSON([])
    } catch (error) {
      consola.error('Query failed:', error)
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Define history command
const historyCommand = defineCommand({
  meta: {
    name: 'history',
    description: 'Get deployment history for a contract on a network',
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
    format: {
      type: 'string',
      description: 'Output format (json or table)',
      default: 'json',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate format
    if (args.format !== 'json' && args.format !== 'table') {
      consola.error('Format must be either "json" or "table"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await querier.connect()
      const deployments = await querier.getDeploymentHistory(
        args.contract,
        args.network
      )

      if (deployments.length > 0)
        if (args.format === 'table') {
          consola.success(`Found ${deployments.length} deployment(s):`)
          deployments.forEach((deployment) => {
            console.log(formatDeployment(deployment))
          })
        } else outputJSON(deployments)
      else {
        await querier.disconnect()
        process.exit(1)
      }
    } catch (error) {
      consola.error('Query failed:', error)
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Define exists command (for bash script compatibility)
const existsCommand = defineCommand({
  meta: {
    name: 'exists',
    description:
      'Check if a deployment exists (bash-compatible - returns exit code 0 if exists, 1 if not)',
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
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await querier.connect()
      const deployments = await querier.filterDeployments({
        contractName: args.contract,
        network: args.network,
        version: args.version,
        limit: 1,
      })

      // Exit with code 0 if exists, 1 if not (bash-compatible)
      process.exit(deployments.length > 0 ? 0 : 1)
    } catch (error) {
      // Exit with error code on failure
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Define get command (for bash script data retrieval)
const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get deployment info as JSON',
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
    format: {
      type: 'string',
      description: 'Output format (json or table)',
      default: 'json',
    },
  },
  async run({ args }) {
    // Validate environment
    if (args.env !== 'staging' && args.env !== 'production') {
      consola.error('Environment must be either "staging" or "production"')
      process.exit(1)
    }

    // Validate format
    if (args.format !== 'json' && args.format !== 'table') {
      consola.error('Format must be either "json" or "table"')
      process.exit(1)
    }

    const querier = new DeploymentLogQuerier(
      config,
      args.env as 'staging' | 'production'
    )

    try {
      await querier.connect()
      const deployments = await querier.filterDeployments({
        contractName: args.contract,
        network: args.network,
        version: args.version,
        limit: 1,
      })

      if (deployments.length === 0) {
        await querier.disconnect()
        process.exit(1)
      }

      const deployment = deployments[0]
      if (!deployment) {
        await querier.disconnect()
        process.exit(1)
      }

      if (args.format === 'table') console.log(formatDeployment(deployment))
      else console.log(JSON.stringify(deployment, null, 2))
    } catch (error) {
      await querier.disconnect()
      process.exit(1)
    } finally {
      await querier.disconnect()
    }
  },
})

// Main command with subcommands
const main = defineCommand({
  meta: {
    name: 'query-deployment-logs',
    description: 'Query deployment logs from MongoDB',
    version: '1.0.0',
  },
  subCommands: {
    latest: latestCommand,
    list: listCommand,
    find: findCommand,
    filter: filterCommand,
    history: historyCommand,
    exists: existsCommand,
    get: getCommand,
  },
})

// Run the CLI
runMain(main)

export { DeploymentLogQuerier, IDeploymentRecord }
