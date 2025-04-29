import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { MongoClient } from 'mongodb'
import consola from 'consola'

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
  },
  async run({ args }) {
    const { network, rpcUrl, environment } = args
    // Use the provided network as the chainName
    const chainName = network

    // Connect to MongoDB using the MONGODB_URI from environment variables
    const MONGODB_URI = process.env.MONGODB_URI as string
    if (!MONGODB_URI) {
      consola.error('MONGODB_URI is not defined in the environment')
      process.exit(1)
    }

    const client = new MongoClient(MONGODB_URI)
    await client.connect()
    const db = client.db('blockchain_configs')
    const collection = db.collection('rpc_endpoints')

    // Check if there's an existing document for the given chainName
    const existingDoc = await collection.findOne({ chainName })

    // Check if the RPC endpoint already exists for the given chain
    if (existingDoc && existingDoc.rpcs) {
      const existingRpcIndex = existingDoc.rpcs.findIndex(
        (rpc: { url: string }) => rpc.url === rpcUrl
      )

      if (existingRpcIndex !== -1) {
        // Calculate highest priority excluding the current endpoint
        const otherEndpoints = existingDoc.rpcs.filter(
          (_: any, index: number) => index !== existingRpcIndex
        )
        const newPriority =
          otherEndpoints.length > 0
            ? Math.max(
                ...otherEndpoints.map(
                  (rpc: { priority: number }) => rpc.priority || 0
                )
              ) + 1
            : 1

        // Update the priority of the existing RPC endpoint
        await collection.updateOne(
          { chainName },
          {
            $set: {
              lastUpdated: new Date(),
              [`rpcs.${existingRpcIndex}.priority`]: newPriority,
              [`rpcs.${existingRpcIndex}.environment`]: environment,
            },
          }
        )

        consola.success(
          `Updated priority of existing RPC endpoint ${rpcUrl} to ${newPriority}`
        )
        await client.close()
        return
      }
    }

    // Calculate the new highest priority for new endpoints
    let newPriority = 1
    if (
      existingDoc &&
      Array.isArray(existingDoc.rpcs) &&
      existingDoc.rpcs.length > 0
    ) {
      newPriority =
        Math.max(
          ...existingDoc.rpcs.map(
            (rpc: { priority: number }) => rpc.priority || 0
          )
        ) + 1
    }

    // Construct the new RPC endpoint object with the new highest priority
    const newRpcEndpoint = { url: rpcUrl, priority: newPriority, environment }

    // Update (or create) the document by merging the new RPC endpoint
    await collection.updateOne(
      { chainName },
      {
        $set: { lastUpdated: new Date() },
        $push: { rpcs: { $each: [newRpcEndpoint] } },
      } as any,
      { upsert: true }
    )

    consola.success(
      `RPC endpoint added successfully with priority ${newPriority}`
    )
    await client.close()
  },
})

runMain(main)
