import { MongoClient } from 'mongodb'
import { config } from 'dotenv'

config()

const MONGO_URI = process.env.MONGODB_URI as string
if (!MONGO_URI) {
  throw new Error('MONGODB_URI is not defined in the environment')
}

async function run() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()

  const db = client.db('blockchain_configs')
  const collection = db.collection('rpc_endpoints')

  const chainName = 'mainnet' // must match with name from networks.json
  const chainDoc = {
    chainName,
    rpcs: [
      {
        url: '<rpc_url>',
        priority: 1,
        environment: 'production',
      },
      {
        url: '<rpc_url>',
        priority: 2,
        environment: 'production',
      },
      {
        url: '<rpc_url>',
        priority: 3,
        environment: 'production',
      },
    ],
    lastUpdated: new Date(),
  }

  await collection.updateOne(
    { chainName },
    { $set: chainDoc },
    { upsert: true }
  )

  console.log('RPC endpoints stored successfully.')
  await client.close()
}

run().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
