#!/usr/bin/env bun

import fs from 'fs'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import { getEnvVar } from './safe/safe-utils'

// Interface for LDA Diamond file structure
interface ILDADiamondFile {
  [diamondName: string]: {
    Facets: {
      [address: string]: {
        Name: string
        Version: string
      }
    }
    Periphery?: {
      [name: string]: string
    }
  }
}

const main = defineCommand({
  meta: {
    name: 'updateLDADiamondLog',
    description: 'Update LDA Diamond deployment logs',
  },
  args: {
    environment: {
      type: 'string',
      description: 'Environment (staging or production)',
      required: true,
    },
    network: {
      type: 'string',
      description: 'Network name (optional, if not provided updates all networks)',
      required: false,
    },
    contractName: {
      type: 'string',
      description: 'Contract name to update',
      required: false,
    },
    address: {
      type: 'string',
      description: 'Contract address',
      required: false,
    },
    version: {
      type: 'string',
      description: 'Contract version',
      required: false,
    },
    isPeriphery: {
      type: 'boolean',
      description: 'Whether the contract is periphery',
      default: false,
    },
  },
})

const updateLDADiamond = function (
  name: string,
  network: string,
  address: string,
  isProduction: boolean,
  options: {
    isPeriphery?: boolean
    version?: string
  }
) {
  let data: ILDADiamondFile = {}

  const ldaDiamondContractName = 'LDADiamond'

  const ldaDiamondFile = isProduction
    ? `deployments/${network}.lda.diamond.json`
    : `deployments/${network}.lda.diamond.staging.json`

  try {
    data = JSON.parse(fs.readFileSync(ldaDiamondFile, 'utf8')) as ILDADiamondFile
  } catch {
    // File doesn't exist yet, start with empty structure
  }

  if (!data[ldaDiamondContractName])
    data[ldaDiamondContractName] = {
      Facets: {},
      Periphery: {},
    }

  if (options.isPeriphery) {
    data[ldaDiamondContractName].Periphery![name] = address
  } else {
    // Check if entry with name already exists
    // If so, replace it
    data[ldaDiamondContractName].Facets = Object.fromEntries(
      Object.entries(data[ldaDiamondContractName].Facets).map(([key, value]) => {
        if (value.Name === name)
          return [address, { Name: name, Version: options.version || '' }]

        return [key, value]
      })
    )
    // If not, add new entry
    data[ldaDiamondContractName].Facets[address] = {
      Name: name,
      Version: options.version || '',
    }
  }

  fs.writeFileSync(ldaDiamondFile, JSON.stringify(data, null, 2))
  
  consola.success(`Updated LDA diamond log for ${name} at ${address} in ${ldaDiamondFile}`)
}

const updateAllLDANetworks = function (environment: string) {
  try {
    // Read networks configuration
    const networksConfigPath = './config/networks.json'
    if (!fs.existsSync(networksConfigPath)) {
      consola.error('Networks config file not found')
      return
    }

    const networksConfig = JSON.parse(fs.readFileSync(networksConfigPath, 'utf8'))
    const networks = Object.keys(networksConfig)
    
    consola.info(`Updating LDA diamond logs for ${networks.length} networks in ${environment} environment`)

    for (const network of networks) {
      try {
        // Read network-specific deployment file
        const deploymentFileSuffix = environment === 'production' ? 'json' : 'staging.json'
        const deploymentFile = `deployments/${network}.lda.${deploymentFileSuffix}`
        
        if (!fs.existsSync(deploymentFile)) {
          consola.warn(`LDA deployment file not found for ${network}: ${deploymentFile}`)
          continue
        }

        const deployments = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'))
        
        // Update LDA diamond log for each deployed contract
        for (const [contractName, contractAddress] of Object.entries(deployments)) {
          if (typeof contractAddress === 'string') {
            // Get version from contract if possible (simplified version)
            const version = '1.0.0' // Default version - could be enhanced to read actual version
            
            updateLDADiamond(
              contractName,
              network,
              contractAddress,
              environment === 'production',
              {
                isPeriphery: false, // Could be enhanced to detect periphery contracts
                version,
              }
            )
          }
        }
        
        consola.success(`Updated LDA diamond log for network: ${network}`)
      } catch (error) {
        consola.error(`Failed to update LDA diamond log for ${network}:`, error)
      }
    }
  } catch (error) {
    consola.error('Failed to update LDA diamond logs for all networks:', error)
  }
}

export default main

export { updateLDADiamond, updateAllLDANetworks }

// Handle direct execution
if (import.meta.main) {
  runMain(main).then((args) => {
    try {
      const environment = args.environment
      const network = args.network
      const contractName = args.contractName
      const address = args.address
      const version = args.version
      const isPeriphery = args.isPeriphery

      // Validate environment
      if (!['staging', 'production'].includes(environment)) {
        consola.error('Environment must be either "staging" or "production"')
        process.exit(1)
      }

      if (network && contractName && address) {
        // Update specific contract
        updateLDADiamond(
          contractName,
          network,
          address,
          environment === 'production',
          {
            isPeriphery,
            version,
          }
        )
      } else if (network) {
        // Update specific network
        consola.info(`Updating LDA diamond log for network: ${network}`)
        // This would need implementation for single network update
        consola.warn('Single network update not yet implemented, updating all networks')
        updateAllLDANetworks(environment)
      } else {
        // Update all networks
        updateAllLDANetworks(environment)
      }
      
      consola.success('LDA diamond log update completed')
    } catch (error) {
      consola.error('Failed to update LDA diamond log:', error)
      process.exit(1)
    }
  })
}
