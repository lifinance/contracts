import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { mongoEq } from '../deploy/shared/mongo-log-utils'

import {
  hasApiCredentials,
  hostOf,
  lowestPriorityFor,
  selectEndpoints,
  type IRpcEndpoint,
} from './rpcEndpoints'

const main = defineCommand({
  meta: {
    name: 'add-network-rpc',
    description: 'Add a new RPC endpoint to the blockchain configuration',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name to which the RPC endpoint should be added',
      required: true,
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL of the endpoint to add',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment of the RPC endpoint (default is production)',
      required: false,
      default: 'production',
    },
    priority: {
      type: 'string',
      description:
        'Priority of the endpoint, highest wins. Omit to add below every existing endpoint',
      required: false,
    },
  },
  async run({ args }) {
    const { network, rpcUrl, environment } = args
    // Use the provided network as the chainName
    const chainName = network

    let requestedPriority: number | undefined
    if (args.priority !== undefined) {
      requestedPriority = Number(args.priority)
      if (!Number.isFinite(requestedPriority)) {
        consola.error(`--priority must be a number, got "${args.priority}"`)
        process.exit(1)
      }
    }

    // Connect to MongoDB using the MONGODB_URI from environment variables
    const MONGODB_URI = process.env.MONGODB_URI as string
    if (!MONGODB_URI) {
      consola.error('MONGODB_URI is not defined in the environment')
      process.exit(1)
    }

    const client = new MongoClient(MONGODB_URI)
    let exitCode = 0
    try {
      await client.connect()
      const db = client.db('blockchain-configs')
      const collection = db.collection('RpcEndpoints')

      // Check if there's an existing document for the given chainName
      const existingDoc = await collection.findOne({
        chainName: mongoEq(chainName),
      })
      const existingRpcs: IRpcEndpoint[] = Array.isArray(existingDoc?.rpcs)
        ? existingDoc.rpcs
        : []

      const existingRpcIndex = existingRpcs.findIndex(
        (rpc) => rpc.url === rpcUrl
      )

      if (existingRpcIndex !== -1) {
        // Re-adding a known endpoint must not reshuffle the chain's ordering on its own: without
        // an explicit priority this is a metadata refresh, and silently promoting the URL is how a
        // credentialed primary gets demoted by a routine re-run.
        const update: Record<string, unknown> = {
          lastUpdated: new Date(),
          [`rpcs.${existingRpcIndex}.environment`]: environment,
          [`rpcs.${existingRpcIndex}.isActive`]:
            existingRpcs[existingRpcIndex]?.isActive ?? true,
        }
        if (requestedPriority !== undefined)
          update[`rpcs.${existingRpcIndex}.priority`] = requestedPriority

        await collection.updateOne(
          { chainName: mongoEq(chainName) },
          { $set: update }
        )

        if (requestedPriority !== undefined)
          consola.success(
            `Updated priority of existing RPC endpoint to ${requestedPriority}`
          )
        else
          consola.success(
            `RPC endpoint already present; refreshed metadata and kept priority ${
              existingRpcs[existingRpcIndex]?.priority ?? 'unset'
            }`
          )
      } else {
        const newRpcEndpoint = {
          url: rpcUrl,
          priority: requestedPriority ?? lowestPriorityFor(existingRpcs),
          environment,
          isActive: true,
        }

        await collection.updateOne(
          { chainName: mongoEq(chainName) },
          {
            $set: { lastUpdated: new Date() },
            $push: {
              rpcs: newRpcEndpoint,
            } as any,
          },
          { upsert: true }
        )

        consola.success(
          `RPC endpoint added successfully with priority ${newRpcEndpoint.priority}`
        )
      }

      await reportResultingOrder(collection, chainName, environment)
    } catch (error) {
      consola.error('MongoDB operation failed:', error)
      exitCode = 1
    } finally {
      await client.close()
    }
    if (exitCode !== 0) process.exit(exitCode)
  },
})

/**
 * Print the order the chain now resolves in, so the operator sees which endpoint became primary
 * rather than inferring it from the priority number alone.
 */
async function reportResultingOrder(
  collection: {
    findOne: (
      filter: Record<string, unknown>
    ) => Promise<{ rpcs?: IRpcEndpoint[] } | null>
  },
  chainName: string,
  environment: string
) {
  const doc = await collection.findOne({ chainName: mongoEq(chainName) })
  const ordered = selectEndpoints(
    Array.isArray(doc?.rpcs) ? doc.rpcs : [],
    environment
  )
  if (!ordered.length) return

  consola.info(`Resolved order for ${chainName} [${environment}]:`)
  ordered.forEach((endpoint, index) => {
    const credentials = hasApiCredentials(endpoint.url) ? 'keyed' : 'no key'
    consola.info(
      `  ${index === 0 ? 'primary ' : `fallback${index}`} p=${
        endpoint.priority
      } ${hostOf(endpoint.url)} (${credentials})`
    )
  })
}

runMain(main)
