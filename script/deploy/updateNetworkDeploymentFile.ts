// @ts-nocheck
import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as path from 'path'
import * as fs from 'fs'
import toml from 'toml' // make sure to install this: npm install toml
import { Address, PublicClient, createPublicClient, http } from 'viem'
import {
  Network,
  networks,
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'

const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Deployment File Update',
    description:
      'Updates the deployment file to match the latest on-chain state.',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
  },
  async run({ args }) {
    let { network } = args
    network = network.toLowerCase()

    consola.info(`Starting update process for network: ${network}`)

    const networkDeploymentPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.json`
    )
    const { default: deployedContracts } = await import(networkDeploymentPath)
    const networksConfig = await import('../../config/networks.json')

    const chain = getViemChainForNetworkName(network)
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    // ┌─────────────────────────────────────────────────────────┐
    // │   Check if Diamond Contract is deployed                 │
    // └─────────────────────────────────────────────────────────┘
    consola.box('Checking LiFiDiamond contract deployment...')
    const diamondDeployed = await checkIsDeployed(
      'LiFiDiamond',
      deployedContracts,
      publicClient
    )

    if (!diamondDeployed) {
      consola.error('LiFiDiamond contract is not deployed. Exiting process.')
      throw new Error('Diamond contract not found on-chain.')
    }
    consola.success('LiFiDiamond contract is deployed.')

    const diamondAddress = deployedContracts['LiFiDiamond']

    // ┌─────────────────────────────────────────────────────────┐
    // │   Check if all facets are registered in the diamond     │
    // └─────────────────────────────────────────────────────────┘
    consola.box('Verifying registered facets in LiFiDiamond...')
    $.quiet = true

    try {
      const foundryTomlPath = path.resolve(__dirname, '../../foundry.toml')
      const foundryTomlContent = fs.readFileSync(foundryTomlPath, 'utf8')
      const foundryConfig = toml.parse(foundryTomlContent)

      const etherscanConfig = foundryConfig.etherscan[network]
      if (!etherscanConfig) {
        throw new Error(
          `Etherscan configuration not found for network: ${network}`
        )
      }
      const baseUrl = etherscanConfig.url

      const rpcUrl: string = networksConfig[network]?.rpcUrl
      if (!rpcUrl) throw new Error(`RPC URL not found for network: ${network}`)

      const facetsResult =
        await $`cast call ${diamondAddress} "facets() returns ((address,bytes4[])[])" --rpc-url ${rpcUrl}`
      const rawString = facetsResult.stdout

      const jsonCompatibleString = rawString
        .replace(/\(/g, '[')
        .replace(/\)/g, ']')
        .replace(/0x[0-9a-fA-F]+/g, '"$&"')

      const onChainFacets = JSON.parse(jsonCompatibleString)

      if (!Array.isArray(onChainFacets)) {
        throw new Error('Unexpected format for on-chain facets data.')
      }

      // Map on-chain facet addresses to names in config
      const configFacetsByAddress = Object.fromEntries(
        Object.entries(deployedContracts)
          .filter(([name]) => name.includes('Facet'))
          .map(([name, address]) => [address.toLowerCase(), name])
      )

      const onChainFacetAddresses = onChainFacets.map(([address]) =>
        address.toLowerCase()
      )
      const missingInConfig = onChainFacetAddresses.filter(
        (address) => !configFacetsByAddress[address]
      )

      if (missingInConfig.length > 0) {
        consola.warn(
          `Detected missing facets in ${network}.json: ${JSON.stringify(
            missingInConfig
          )}`
        )
        consola.info(
          `This may be due to outdated addresses in ${network}.json.`
        )

        // Retrieve API key
        const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
        const apiKey = process.env[apiKeyEnvVar]

        if (!apiKey) {
          throw new Error(
            `Missing API key for ${network}. Ensure it's set in the environment variables.`
          )
        }

        for (const missingContractAddress of missingInConfig) {
          consola.log(`\n`)
          consola.info(
            `Fetching contract details for missing address: ${missingContractAddress}`
          )

          const url = new URL(baseUrl)
          url.searchParams.append('module', 'contract')
          url.searchParams.append('action', 'getsourcecode')
          url.searchParams.append('address', missingContractAddress)
          url.searchParams.append('apiKey', apiKey)

          const response = await fetch(url.toString())
          const data = await response.json()

          if (data.result.includes('Invalid API Key')) {
            consola.error(data.result)
            continue
          }
          if (
            data.result.includes(
              'Missing or unsupported chainid parameter (required for v2 api)'
            )
          ) {
            consola.warn(
              'Missing or unsupported chainid parameter (required for v2 api). Please see https://api.etherscan.io/v2/chainlist for the list of supported chainids.'
            )
            continue
          }

          const contractName = data.result[0]?.ContractName
          if (!contractName) {
            // TODO compare facet byte codes
            // TODO try to verify contract
            consola.error(
              `Skipping ${missingContractAddress}: No contract name found.`
            )
            continue
          }

          consola.info(
            `Checking if ${contractName} already exists in ${network}.json...`
          )
          if (deployedContracts[contractName]) {
            consola.info(
              `Updating ${contractName}: ${deployedContracts[contractName]} → ${missingContractAddress}`
            )
          } else {
            consola.info(
              `Adding new contract: ${contractName} (${missingContractAddress})`
            )
          }
          deployedContracts[contractName] = missingContractAddress
        }

        fs.writeFileSync(
          networkDeploymentPath,
          JSON.stringify(deployedContracts, null, 2)
        )
        consola.success('Deployment file updated successfully.')
      } else {
        consola.success('All contracts are up-to-date.')
      }
    } catch (error) {
      consola.warn('Skipping facet registration check due to an error:')
      consola.error(error.message)
    }
  },
})

const checkIsDeployed = async (
  contract: string,
  deployedContracts: Record<string, Address>,
  publicClient: PublicClient
): Promise<boolean> => {
  const address = deployedContracts[contract]
  if (!address) return false

  const code = await publicClient.getCode({ address })
  return code !== '0x'
}

runMain(main)
