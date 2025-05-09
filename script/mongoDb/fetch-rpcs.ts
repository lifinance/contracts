import { MongoClient } from 'mongodb'
import fs from 'fs'
import { config } from 'dotenv'
import consola from 'consola'
config()

interface RpcEndpoint {
  url: string
  priority: number
}

async function fetchRpcEndpoints(): Promise<{
  [network: string]: RpcEndpoint[]
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
    const endpoints: { [network: string]: RpcEndpoint[] } = {}

    await cursor.forEach((doc) => {
      if (doc?.chainName && Array.isArray(doc?.rpcs)) {
        const validEndpoints: RpcEndpoint[] = doc.rpcs.filter(
          (r: any) => !!r.url
        )
        // Sort endpoints in descending order so that the endpoint with the highest priority comes first
        validEndpoints.sort((a, b) => b.priority - a.priority)
        if (validEndpoints.length > 0) {
          const envVar = `ETH_NODE_URI_${doc.chainName.toUpperCase()}`
          endpoints[envVar] = validEndpoints
        }
      }
    })

    await client.close()
    return endpoints
  } catch (error) {
    try {
      await client.close()
    } catch {
      /* ignore closure errors */
    }
    throw new Error(`Failed to fetch RPC endpoints: ${error}`)
  }
}

async function mergeEndpointsIntoEnv() {
  try {
    // Try to fetch from MongoDB first
    let newEndpoints: { [network: string]: RpcEndpoint[] } = {}
    try {
      newEndpoints = await fetchRpcEndpoints()
    } catch (error) {
      consola.warn(
        'Failed to fetch from MongoDB, falling back to networks.json:',
        error
      )
      // Fall back to networks.json
      const networks = (await import('../../config/networks.json')).default
      newEndpoints = Object.entries(networks).reduce(
        (acc, [networkName, config]) => {
          const envVar = `ETH_NODE_URI_${networkName.toUpperCase()}`
          acc[envVar] = [
            {
              url: config.rpcUrl,
              priority: 1,
            },
          ]
          return acc
        },
        {} as { [network: string]: RpcEndpoint[] }
      )
    }

    // Group endpoints by first letter after "ETH_NODE_URI_"
    const groupedEndpoints = Object.entries(newEndpoints).reduce(
      (acc: { [key: string]: [string, RpcEndpoint[]][] }, [key, endpoints]) => {
        const networkName = key.replace('ETH_NODE_URI_', '')
        const firstLetter = networkName.charAt(0)
        if (!acc[firstLetter]) acc[firstLetter] = []
        acc[firstLetter].push([key, endpoints])
        return acc
      },
      {}
    )

    // Sort the groups by letter and sort entries within each group
    const sortedGroups = Object.keys(groupedEndpoints)
      .sort()
      .map((letter) => {
        const group = groupedEndpoints[letter].sort(([keyA], [keyB]) => {
          const nameA = keyA.replace('ETH_NODE_URI_', '')
          const nameB = keyB.replace('ETH_NODE_URI_', '')
          return nameA.localeCompare(nameB)
        })

        // Process each chain's endpoints separately and add spacing between chains
        const processedEntries = group.map(([key, endpoints]) => {
          const chainEntries = endpoints.map((endpoint, index) => {
            // Store the RPC URL without the comment in the environment variable
            const envEntry = `${key}="${endpoint.url}"`
            // Add the comment after a space so it's treated as a shell comment
            return index === 0
              ? `${envEntry} # [pre-commit-checker: not a secret]`
              : `# ${envEntry} # [pre-commit-checker: not a secret]`
          })
          // Add a blank line after each chain's entries
          return [...chainEntries, '']
        })

        return {
          letter,
          // Flatten all chains' entries
          entries: processedEntries.flat(),
        }
      })

    // Flatten groups with headers and spacing
    const newLines = sortedGroups.flatMap((group, index) => [
      // Add a blank line before each group except the first one
      ...(index === 0 ? [] : ['']),
      // Add the letter header
      `# ====================== ${group.letter} ======================`,
      // Add the group entries (which now include spacing between chains)
      ...group.entries,
    ])

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
  } catch (error) {
    consola.error('Failed to fetch RPC endpoints into .env:', error)
    process.exit(1)
  }
}

mergeEndpointsIntoEnv()
