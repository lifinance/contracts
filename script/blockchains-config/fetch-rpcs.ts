import { MongoClient } from 'mongodb'
import fs from 'fs'
import { config } from 'dotenv'
import consola from 'consola'
config()

interface RpcEndpoint {
  url: string
  priority: number
}

async function fetchRpcEndpoints(): Promise<{ [network: string]: string }> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI)
    throw new Error('MONGODB_URI is not defined in the environment')

  const client = new MongoClient(MONGODB_URI)
  await client.connect()
  const db = client.db('blockchain_configs')
  const collection = db.collection('rpc_endpoints')

  // Suppose each document has a chainName field and an array of endpoints in "rpcs"
  const cursor = collection.find({})
  const endpoints: { [network: string]: string } = {}

  await cursor.forEach((doc) => {
    if (doc.chainName && Array.isArray(doc.rpcs)) {
      const validEndpoints: RpcEndpoint[] = doc.rpcs.filter((r: any) => !!r.url)
      // Sort endpoints in descending order so that the endpoint with the highest priority comes first.
      validEndpoints.sort((a, b) => b.priority - a.priority)
      if (validEndpoints.length > 0) {
        // Construct an environment variable name (e.g., ETH_NODE_URI_POLYGON)
        const envVar = `ETH_NODE_URI_${doc.chainName.toUpperCase()}`
        endpoints[envVar] = validEndpoints[0].url
      }
    }
  })

  await client.close()
  return endpoints
}

async function mergeEndpointsIntoEnv() {
  try {
    // Fetch new endpoints from MongoDB
    const newEndpoints = await fetchRpcEndpoints()

    // Generate new endpoint lines, sorted alphabetically by key
    const newLines = Object.entries(newEndpoints)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, value]) => `${key}="${value}"`)

    // Read the existing .env file, or start with an empty string if it doesn't exist
    let envContent = ''
    try {
      envContent = fs.readFileSync('.env', 'utf8')
    } catch (err) {
      consola.warn('.env file not found; a new one will be created.')
    }

    // Filter out any existing ETH_NODE_URI_* lines (even if commented out)
    const filteredLines = envContent.split('\n').filter((line) => {
      // Remove any line that contains an ETH_NODE_URI_ variable assignment,
      // regardless of preceding whitespace or a comment character.
      return !/^\s*#?\s*ETH_NODE_URI_[A-Z0-9_]+\s*=/.test(line)
    })

    // Prepend the new endpoint lines to the remaining content
    const mergedContent =
      [...newLines, '', ...filteredLines].join('\n').trim() + '\n'

    // Write the merged content back to the .env file.
    fs.writeFileSync('.env', mergedContent)
    consola.success('RPC endpoints fetched successfully into .env')
  } catch (error) {
    consola.error('Failed to fetch RPC endpoints into .env:', error)
    process.exit(1)
  }
}

mergeEndpointsIntoEnv()
