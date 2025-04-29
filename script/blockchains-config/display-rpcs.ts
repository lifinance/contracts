import { MongoClient } from 'mongodb'
import { config } from 'dotenv'
import consola from 'consola'
import { defineCommand, runMain } from 'citty'
config()

interface RpcEndpoint {
  url: string
  priority: number
}

const main = defineCommand({
  meta: {
    name: 'display-rpcs',
    description: 'Display RPC endpoints for a specific network',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name to display RPC endpoints for',
      required: true,
    },
  },
  async run({ args }) {
    const { network } = args

    try {
      const MONGODB_URI = process.env.MONGODB_URI
      if (!MONGODB_URI)
        throw new Error('MONGODB_URI is not defined in the environment')

      const client = new MongoClient(MONGODB_URI)
      await client.connect()
      const db = client.db('blockchain_configs')
      const collection = db.collection('rpc_endpoints')

      const doc = await collection.findOne({ chainName: network })

      if (!doc) {
        consola.warn(`No RPC endpoints found for network: ${network}`)
        await client.close()
        return
      }

      if (!Array.isArray(doc.rpcs) || doc.rpcs.length === 0) {
        consola.warn(`No RPC endpoints configured for network: ${network}`)
        await client.close()
        return
      }

      // Sort endpoints by priority in descending order
      const sortedEndpoints = [...doc.rpcs].sort(
        (a, b) => b.priority - a.priority
      )

      consola.info(`RPC endpoints for ${network}:`)
      sortedEndpoints.forEach((endpoint: RpcEndpoint, index: number) => {
        consola.info(`${index + 1}. URL: ${endpoint.url}`)
        consola.info(`   Priority: ${endpoint.priority}`)
        consola.info('---')
      })

      await client.close()
    } catch (error) {
      consola.error('Failed to fetch RPC endpoints:', error)
      process.exit(1)
    }
  },
})

runMain(main)
