import fs from 'fs'
import path from 'path'

import { config } from 'dotenv'

import { readContractVersion } from '../deploy/shared/contract-version'

import { getNetworkConfig } from './utils'

config()

async function updateDeploymentLogs(network: string) {
  try {
    // Read network configuration
    const networkConfig = getNetworkConfig(network)

    // Read deployment file
    const deploymentPath = path.join('deployments', `${network}.json`)
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

    // Read master deployment log
    const masterLogPath = 'deployments/_deployments_log_file.json'
    const masterLog = JSON.parse(fs.readFileSync(masterLogPath, 'utf8'))

    // Get API key from environment variables
    const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
    const apiKey = process.env[apiKeyEnvVar]

    if (!apiKey) throw new Error(`API key not found for ${network}`)

    console.log(`Fetching details for deployed contracts on ${network}...`)
    // Process each contract
    for (const [contractName, contractAddress] of Object.entries(deployments))
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

        // Extract version from source code. An explorer returns a single-file
        // contract as plain source but a multi-file one as a JSON bundle whose
        // newlines are escaped, and the tag is only at the start of a line in the
        // first shape — so unescape before reading rather than reporting every
        // multi-file contract as versionless.
        const sourceCode = (data.result[0].SourceCode as string).replace(
          /\\r\\n|\\n/gu,
          '\n'
        )
        const read = readContractVersion(sourceCode)
        let version = read.kind === 'ok' ? read.version : null

        if (read.kind === 'malformed')
          console.log(
            `${contractName}: '${read.raw}' is not a version. Assuming 1.0.0`
          )

        if (!version) {
          console.log(
            `Skipping ${contractName}: No version found. Assuming 1.0.0`
          )
          version = '1.0.0'
        }

        // Update master log
        console.log(`Updating ${contractName} - ${contractAddress}...`)
        if (!masterLog[contractName]) masterLog[contractName] = {}

        if (!masterLog[contractName][network])
          masterLog[contractName][network] = {}

        if (!masterLog[contractName][network].production)
          masterLog[contractName][network].production = {}

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
        } else console.log('Entry already exists')
      } catch (error) {
        console.error(`Error processing ${contractName}:`, error)
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
