import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

async function updateDeploymentLogs(network: string) {
  try {
    // Read network configuration
    const networksConfig = JSON.parse(
      fs.readFileSync('config/networks.json', 'utf8')
    )
    const networkConfig = networksConfig[network]

    if (!networkConfig) {
      throw new Error(`Network ${network} not found in config`)
    }

    // Read deployment file
    const deploymentPath = path.join('deployments', `${network}.json`)
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

    // Read master deployment log
    const masterLogPath = 'deployments/_deployments_log_file.json'
    const masterLog = JSON.parse(fs.readFileSync(masterLogPath, 'utf8'))

    // Get API key from environment variables
    const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
    const apiKey = process.env[apiKeyEnvVar]

    if (!apiKey) {
      throw new Error(`API key not found for ${network}`)
    }

    console.log(`Fetching details for deployed contracts on ${network}...`)
    // Process each contract
    for (const [contractName, contractAddress] of Object.entries(deployments)) {
      try {
        // Call explorer API
        const url = new URL(networkConfig.explorerApiUrl)
        url.searchParams.append('module', 'contract')
        url.searchParams.append('action', 'getsourcecode')
        url.searchParams.append('address', contractAddress as string)
        url.searchParams.append('apiKey', apiKey)

        const response = await fetch(url.toString())
        const data = await response.json()

        if (!data.result[0].SourceCode) {
          console.log(`Skipping ${contractName}: No source code found`)
          continue
        }

        // Extract version from source code
        const sourceCode = data.result[0].SourceCode
        const versionMatch = sourceCode.match(
          /\/\/\/\s*@custom:version\s*([\d.]+)/
        )
        let version = versionMatch ? versionMatch[1] : null

        if (!version) {
          console.log(
            `Skipping ${contractName}: No version found. Assuming 1.0.0`
          )
          version = '1.0.0'
        }

        // Update master log
        console.log(`Updating ${contractName} - ${contractAddress}...`)
        if (!masterLog[contractName]) {
          masterLog[contractName] = {}
        }
        if (!masterLog[contractName][network]) {
          masterLog[contractName][network] = {}
        }
        if (!masterLog[contractName][network].production) {
          masterLog[contractName][network].production = {}
        }
        if (!masterLog[contractName][network].production[version]) {
          masterLog[contractName][network].production[version] = [
            {
              ADDRESS: contractAddress,
              OPTIMIZER_RUNS: data.result[0].Runs || 0,
              TIMESTAMP: new Date().toISOString(),
              CONSTRUCTOR_ARGS: data.result[0].ConstructorArguments
                ? normalizeBytes(data.result[0].ConstructorArguments)
                : '0x',
              SALT: '',
              VERIFIED: true,
            },
          ]
          console.log('Updated')
        } else {
          console.log('Entry already exists')
        }
      } catch (error) {
        console.error(`Error processing ${contractName}:`, error)
      }
    }

    // Write updated master log
    fs.writeFileSync(masterLogPath, JSON.stringify(masterLog, null, 2))
    console.log(`Successfully updated deployment logs for ${network}`)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

const normalizeBytes = (bytes: string): string => {
  if (bytes.startsWith('0x')) return bytes
  return `0x${bytes}`
}

// Get network from command line arguments
const network = process.argv[2]
if (!network) {
  console.error('Please provide a network name')
  process.exit(1)
}

updateDeploymentLogs(network)
