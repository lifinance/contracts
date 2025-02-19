import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as path from 'path'
import * as fs from 'fs'
import toml from 'toml' // make sure to install this: npm install toml
import { Address, PublicClient, createPublicClient, http } from 'viem'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

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
    const { default: networksConfig } = await import(
      '../../config/networks.json'
    )
    type NetworkName = keyof typeof networksConfig

    let { network } = args
    network = network.toLowerCase() as NetworkName

    consola.info(`Starting update process for network: ${network}`)

    const networkDeploymentLogPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.json`
    )
    const networkDiamondDeploymentLogPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.diamond.json`
    )

    type DeployLogContracts = Record<string, Address>
    const { default: networkDeployLogContracts } = (await import(
      networkDeploymentLogPath
    )) as { default: DeployLogContracts }
    const { default: networkDiamondDeployLogContracts } = (await import(
      networkDiamondDeploymentLogPath
    )) as { default: DeployLogContracts }

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
      networkDeployLogContracts,
      publicClient
    )

    if (!diamondDeployed) {
      consola.error('LiFiDiamond contract is not deployed. Exiting process.')
      throw new Error('Diamond contract not found on-chain.')
    }
    consola.success('LiFiDiamond contract is deployed.')

    const diamondAddress = networkDeployLogContracts['LiFiDiamond']

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

      if (!(network in networksConfig)) {
        throw new Error(`Network "${network}" is not supported.`)
      }

      const baseUrl = etherscanConfig.url
      const typedNetwork = network as NetworkName
      const rpcUrl: string = networksConfig[typedNetwork].rpcUrl
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

      // map on-chain facet addresses to names in config
      const configFacetsByAddress = Object.fromEntries(
        Object.entries(networkDeployLogContracts)
          .filter(([name]) => name.includes('Facet'))
          .map(([name, address]) => [address.toLowerCase(), name])
      )

      const onChainFacetAddresses = onChainFacets.map(([address]) =>
        address.toLowerCase()
      )
      const missingOnChainRegisteredFacetAddressesInDeployLog =
        onChainFacetAddresses.filter(
          (address) => !configFacetsByAddress[address]
        )

      if (missingOnChainRegisteredFacetAddressesInDeployLog.length > 0) {
        consola.warn(
          `Detected missing facets in ${network}.json: ${JSON.stringify(
            missingOnChainRegisteredFacetAddressesInDeployLog
          )}`
        )
        consola.info(
          `This may be due to outdated addresses in ${network}.json.`
        )

        for (const missingOnChainRegisteredFacetAddressInDeployLog of missingOnChainRegisteredFacetAddressesInDeployLog) {
          consola.log(`\n`)
          consola.info(
            `Fetching contract details for missing address: ${missingOnChainRegisteredFacetAddressInDeployLog}`
          )

          const onChainRegisteredFacetContractData = await fetchContractDetails(
            baseUrl,
            missingOnChainRegisteredFacetAddressInDeployLog,
            network
          )

          const onChainRegisteredFacetContractContractName =
            onChainRegisteredFacetContractData.ContractName
          if (!onChainRegisteredFacetContractContractName) {
            // TODO compare facet byte codes
            // TODO try to verify contract
            consola.error(
              `Skipping ${missingOnChainRegisteredFacetAddressInDeployLog}: No contract name found.`
            )
            continue
          }

          consola.info(
            `Checking if ${onChainRegisteredFacetContractContractName} already exists in ${network}.json...`
          )
          if (
            networkDeployLogContracts[
              onChainRegisteredFacetContractContractName
            ]
          ) {
            // check contract versions:
            const onChainRegisteredFacetContractVersion = extractVersion(
              onChainRegisteredFacetContractData.SourceCode
            )
            if (onChainRegisteredFacetContractVersion == null) {
              continue
            }

            const deployLogFacetContractData = await fetchContractDetails(
              baseUrl,
              networkDeployLogContracts[
                onChainRegisteredFacetContractContractName
              ],
              network
            )
            const deployLogFacetContractVersion = extractVersion(
              deployLogFacetContractData.SourceCode
            )
            if (deployLogFacetContractVersion == null) {
              continue
            }

            // now check if onchain registered facet has the newest version compering to contract code which is in our repo
            const contractFilePath = findContractFile(
              `src`,
              onChainRegisteredFacetContractContractName
            )
            if (!contractFilePath) {
              consola.warn(
                `No contract file found for ${onChainRegisteredFacetContractContractName} in src/ folder.`
              )
              continue
            }

            const contractSourceCode = fs.readFileSync(contractFilePath, 'utf8')
            const repoVersion = extractVersion(contractSourceCode)
            if (!repoVersion) {
              consola.warn(`No version found in ${contractFilePath}.`)
              continue
            }
            if (
              compareVersions(
                repoVersion,
                onChainRegisteredFacetContractVersion
              )
            ) {
              consola.error(
                `Onchain registered facet is not the newest version! Found newer version in the repo for ${onChainRegisteredFacetContractContractName} contract. Please update diamond first! Contract name: ${onChainRegisteredFacetContractContractName}, Deploy log contract address: ${networkDeployLogContracts[onChainRegisteredFacetContractContractName]} with version ${onChainRegisteredFacetContractVersion}, Repo version ${repoVersion}`
              )
              if (
                compareVersions(repoVersion, deployLogFacetContractVersion) == 0
              ) {
                // equal
                consola.error(
                  `But there is POTENTIALLY existing deployed facet but it's not registered ${missingOnChainRegisteredFacetAddressInDeployLog}`
                )
              }
            } else {
              consola.info(
                `Updating ${onChainRegisteredFacetContractContractName}: ${networkDeployLogContracts[onChainRegisteredFacetContractContractName]} → ${missingOnChainRegisteredFacetAddressInDeployLog}`
              )
              networkDeployLogContracts[
                onChainRegisteredFacetContractContractName
              ] = missingOnChainRegisteredFacetAddressInDeployLog
            }
          } else {
            consola.info(
              `Adding new registered facet contract: ${onChainRegisteredFacetContractContractName} (${missingOnChainRegisteredFacetAddressInDeployLog})`
            )
            networkDeployLogContracts[
              onChainRegisteredFacetContractContractName
            ] = missingOnChainRegisteredFacetAddressInDeployLog
          }
        }

        fs.writeFileSync(
          networkDeploymentLogPath,
          JSON.stringify(networkDeployLogContracts, null, 2)
        )
        consola.success('Deployment file updated successfully.')
      } else {
        consola.success('All contracts are up-to-date.')
      }
    } catch (error) {
      consola.warn('Skipping facet registration check due to an error:')
      if (error instanceof Error) {
        consola.error(error.message)
      } else {
        consola.error(String(error))
      }
    }
  },
})

function findContractFile(
  baseDir: string,
  contractName: string
): string | null {
  const files = fs.readdirSync(baseDir, { withFileTypes: true })

  for (const file of files) {
    const filePath = path.join(baseDir, file.name)

    if (file.isDirectory()) {
      const result = findContractFile(filePath, contractName)
      if (result) return result
    } else if (file.name === `${contractName}.sol`) {
      return filePath
    }
  }
  return null
}

const fetchContractDetails = async (
  baseUrl: string,
  contractAddress: string,
  network: string
) => {
  consola.log(`\n`)
  consola.info(
    `Fetching contract details for missing address: ${contractAddress}`
  )

  // Retrieve API key
  const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
  const apiKey = process.env[apiKeyEnvVar]

  if (!apiKey) {
    throw new Error(
      `Missing API key for ${network}. Ensure it's set in the environment variables.`
    )
  }

  const url = new URL(baseUrl)
  url.searchParams.append('module', 'contract')
  url.searchParams.append('action', 'getsourcecode')
  url.searchParams.append('address', contractAddress)
  url.searchParams.append('apiKey', apiKey)

  const response = await fetch(url.toString())
  const data = await response.json()

  if (data.result.includes('Invalid API Key')) {
    consola.error(data.result)
    return null
  }
  if (
    data.result.includes(
      'Missing or unsupported chainid parameter (required for v2 api)'
    )
  ) {
    consola.warn(
      'Missing or unsupported chainid parameter (required for v2 api). Please see https://api.etherscan.io/v2/chainlist for the list of supported chainids.'
    )
    return null
  }

  return data.result[0] ?? null
}

function extractVersion(sourceCode: string): string | null {
  const versionMatch = sourceCode.match(/@custom:version\s+([\d.]+)/)
  return versionMatch ? versionMatch[1] : null
}

function parseVersion(version: string): number[] {
  return version.split('.').map((num) => parseInt(num, 10) || 0)
}

function compareVersions(versionA: string, versionB: string): number {
  const aParts = parseVersion(versionA)
  const bParts = parseVersion(versionB)

  for (let i = 0; i < 3; i++) {
    const a = aParts[i] || 0 // default to 0 if missing
    const b = bParts[i] || 0
    if (a > b) return 1 // versionA is greater
    if (a < b) return -1 // versionB is greater
  }
  return 0 // versions are equal
}

const checkIsDeployed = async (
  contract: string,
  networkDeployLogContracts: Record<string, Address>,
  publicClient: PublicClient
): Promise<boolean> => {
  const address = networkDeployLogContracts[contract]
  if (!address) return false

  const code = await publicClient.getCode({ address })
  return code !== '0x'
}

runMain(main)
