import fs from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import { MongoClient } from 'mongodb'

import { getRPCEnvVarName } from '../utils/utils'

import {
  buildEnvLines,
  findUncredentialedPrimaries,
  selectEndpoints,
  type IRpcEndpoint,
} from './rpcEndpoints'

config()

async function fetchRpcEndpoints(environment: string): Promise<{
  [network: string]: IRpcEndpoint[]
}> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI)
    throw new Error('MONGODB_URI is not defined in the environment')

  const client = new MongoClient(MONGODB_URI)

  try {
    await client.connect()
    const db = client.db('blockchain-configs')
    const collection = db.collection('RpcEndpoints')

    const cursor = collection.find({})
    const endpoints: { [network: string]: IRpcEndpoint[] } = {}

    await cursor.forEach((doc) => {
      if (doc?.chainName && Array.isArray(doc?.rpcs)) {
        const usableEndpoints = selectEndpoints(doc.rpcs, environment)
        if (usableEndpoints.length > 0) {
          const envVar = getRPCEnvVarName(doc.chainName)
          endpoints[envVar] = usableEndpoints
        }
      }
    })

    return endpoints
  } catch (error) {
    throw new Error(`Failed to fetch RPC endpoints: ${error}`)
  } finally {
    // Ensure the client is always closed, even if there's an error
    await client.close()
  }
}

/**
 * Surface chains whose primary endpoint carries no provider credentials.
 *
 * A shared public endpoint answers a handful of calls and then rate-limits, which reads
 * downstream as chain drift rather than as throttling — so promoting one to primary has to be
 * visible when the env file is written, not once a fleet sweep goes red.
 */
function reportUncredentialedPrimaries(endpointsByEnvVar: {
  [network: string]: IRpcEndpoint[]
}) {
  const flagged = findUncredentialedPrimaries(endpointsByEnvVar)
  if (!flagged.length) return

  consola.warn(
    `${flagged.length} network(s) resolve to a primary RPC with no API credentials:`
  )
  for (const { network, host } of flagged)
    consola.warn(`  ${network.replace('ETH_NODE_URI_', '')} -> ${host}`)
  consola.warn(
    'Promote a credentialed endpoint with: bun run add-network-rpc --network <name> --rpcUrl <url> --priority <n>'
  )
}

async function mergeEndpointsIntoEnv(environment: string) {
  try {
    // Try to fetch from MongoDB first
    let newEndpoints: { [network: string]: IRpcEndpoint[] } = {}
    try {
      newEndpoints = await fetchRpcEndpoints(environment)
    } catch (error) {
      consola.warn(
        'Failed to fetch from MongoDB, falling back to networks.json:',
        error
      )
      // Fall back to networks.json
      const networks = (await import('../../config/networks.json')).default
      newEndpoints = Object.entries(networks).reduce(
        (acc, [networkName, config]) => {
          const envVar = getRPCEnvVarName(networkName)
          acc[envVar] = [
            {
              url: config.rpcUrl,
              priority: 1,
              isActive: true,
              network: networkName,
            },
          ]
          return acc
        },
        {} as { [network: string]: IRpcEndpoint[] }
      )
    }

    const newLines = buildEnvLines(newEndpoints)

    let envContent = ''
    try {
      envContent = fs.readFileSync('.env', 'utf8')
    } catch (err) {
      consola.warn('.env file not found; a new one will be created.')
    }

    // Filter out any existing content, including both RPC lines and category headers
    const filteredLines = envContent.split('\n').filter((line) => {
      return !(
        /^\s*#?\s*ETH_NODE_URI_[A-Z0-9_]+\s*=/.test(line) ||
        /^\s*#\s*=+\s*[A-Z]\s*=+\s*$/.test(line)
      )
    })

    // Get any remaining non-RPC configuration
    const remainingConfig = filteredLines
      .filter((line) => line.trim() !== '')
      .join('\n')

    // Combine everything together
    const mergedContent = [
      // Add RPC endpoints with categories
      ...newLines,
      // Add a blank line if there's remaining config
      ...(remainingConfig ? ['', remainingConfig] : []),
      // Ensure file ends with newline
      '',
    ].join('\n')

    fs.writeFileSync('.env', mergedContent)
    consola.success('RPC endpoints fetched successfully into .env')

    reportUncredentialedPrimaries(newEndpoints)
  } catch (error) {
    consola.error('Failed to fetch RPC endpoints into .env:', error)
    process.exit(1)
  }
}

const main = defineCommand({
  meta: {
    name: 'fetch-rpcs',
    description:
      'Fetch prioritized RPC endpoints from MongoDB into the env file',
  },
  args: {
    environment: {
      type: 'string',
      description: 'Environment to fetch endpoints for (default is production)',
      required: false,
      default: 'production',
    },
  },
  async run({ args }) {
    await mergeEndpointsIntoEnv(args.environment)
  },
})

runMain(main)
