import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as path from 'path'
import * as fs from 'fs'
import toml from 'toml' // npm install toml
import { Address, PublicClient, createPublicClient, http } from 'viem'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

// ──────────────────────────────────────────────────────────────
// Main Command Definition
// ──────────────────────────────────────────────────────────────

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
    // ──────────────────────────────────────────────────────────────
    // INITIAL SETUP: Load network configuration and deployment logs
    // ──────────────────────────────────────────────────────────────
    const { default: networksConfig } = await import(
      '../../config/networks.json'
    )
    type NetworkName = keyof typeof networksConfig
    let { network } = args
    network = network.toLowerCase() as NetworkName

    consola.info(
      `\n=== Starting Update Process for Network: ${network.toUpperCase()} ===\n`
    )

    // Define paths for the deployment logs
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

    // Load deployment log contracts
    const { default: networkDeployLogContracts } = (await import(
      networkDeploymentLogPath
    )) as { default: Record<string, Address> }
    const { default: networkDiamondDeployLogContracts } = (await import(
      networkDiamondDeploymentLogPath
    )) as { default: Record<string, Address> }

    // Create a public client for on-chain queries
    const chain = getViemChainForNetworkName(network)
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    // ──────────────────────────────────────────────────────────────
    // STEP 1: Check if LiFiDiamond contract is deployed
    // ──────────────────────────────────────────────────────────────
    consola.box('Step 1: Checking LiFiDiamond Contract Deployment')
    const diamondDeployed = await checkIsDeployed(
      'LiFiDiamond',
      networkDeployLogContracts,
      publicClient
    )
    if (!diamondDeployed) {
      consola.error(
        'ERROR: LiFiDiamond contract is not deployed. Exiting process.'
      )
      throw new Error('Diamond contract not found on-chain.')
    }
    consola.success('SUCCESS: LiFiDiamond contract is deployed.')
    const diamondAddress = networkDeployLogContracts['LiFiDiamond']

    // ──────────────────────────────────────────────────────────────
    // STEP 2: Verify and Update Facet Registrations in the Diamond
    // ──────────────────────────────────────────────────────────────
    consola.box('Step 2: Verifying Facet Registrations in LiFiDiamond')
    $.quiet = true
    await verifyAndUpdateFacets({
      network,
      diamondAddress,
      networkDeployLogContracts,
      networksConfig,
      networkDeploymentLogPath,
    })

    consola.success('\n=== Deployment File Updated Successfully ===\n')
  },
})

// ──────────────────────────────────────────────────────────────
// Helper: Verify and Update Facet Registrations
// ──────────────────────────────────────────────────────────────

interface VerifyFacetsParams {
  network: string
  diamondAddress: Address
  networkDeployLogContracts: Record<string, Address>
  networksConfig: any
  networkDeploymentLogPath: string
}

async function verifyAndUpdateFacets({
  network,
  diamondAddress,
  networkDeployLogContracts,
  networksConfig,
  networkDeploymentLogPath,
}: VerifyFacetsParams) {
  try {
    // Read Foundry configuration to get Etherscan settings for the network
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
      throw new Error(
        `Network "${network}" is not supported in the networks configuration.`
      )
    }
    const baseUrl = etherscanConfig.url
    const rpcUrl: string = networksConfig[network].rpcUrl
    if (!rpcUrl) throw new Error(`RPC URL not found for network: ${network}`)

    // ──────────────────────────────────────────────────────────────
    // Retrieve the list of facets registered in the diamond contract
    // ──────────────────────────────────────────────────────────────
    const facetsCmd =
      await $`cast call ${diamondAddress} "facets() returns ((address,bytes4[])[])" --rpc-url ${rpcUrl}`
    const rawFacetsData = facetsCmd.stdout

    // Convert the raw output to a JSON-compatible string then parse it
    const jsonCompatibleString = rawFacetsData
      .replace(/\(/g, '[')
      .replace(/\)/g, ']')
      .replace(/0x[0-9a-fA-F]+/g, '"$&"')
    const onChainFacets = JSON.parse(jsonCompatibleString)
    if (!Array.isArray(onChainFacets)) {
      throw new Error('Unexpected format for on-chain facets data.')
    }

    // Process each on-chain facet contract
    for (const [facetAddress] of onChainFacets) {
      const facetAddressLC = facetAddress.toLowerCase()
      consola.log('\n') // spacing for clarity

      // Fetch facet contract details from explorer
      const facetData = await fetchContractDetails(
        baseUrl,
        facetAddressLC,
        network
      )
      let facetName = facetData?.ContractName

      // Handle unverified contracts (no name found)
      if (!facetName) {
        consola.error(
          `No contract name found for facet at address ${facetAddressLC}. Contract might be unverified.`
        )
        // Attempt to locate contract name from deploy log
        const foundName = Object.keys(networkDeployLogContracts).find(
          (name) =>
            networkDeployLogContracts[name].toLowerCase() === facetAddressLC
        )
        if (!foundName) {
          consola.error(
            `Facet at address ${facetAddressLC} does not exist in the deploy log. Please verify the contract and run the script again.`
          )
          continue
        } else {
          consola.info(
            `Contract name "${foundName}" found in deploy log so the on chain and deploy log addresses matches. The deploy log is up to date but the contract still needs verification.`
          )
          facetName = foundName
        }
      }

      // Determine if this facet already exists in the deploy log
      const deployLogAddress =
        networkDeployLogContracts[facetName]?.toLowerCase() || null

      // Try to locate the contract source file in the project
      const contractFilePath = findContractFile('src', facetName)
      if (!contractFilePath) {
        consola.error(
          `Facet "${facetName}" registered on-chain but contract file not found in src/ folder.`
        )
        const archivePath = findContractFile('archive', facetName)
        if (archivePath) {
          consola.error(
            `File for "${facetName}" found in archive/ folder. Please remove facet from diamond.`
          )
        }
        continue
      }

      // Read and extract the version from the contract source code in the repo
      const contractSource = fs.readFileSync(contractFilePath, 'utf8')
      const repoVersion = extractVersion(contractSource)
      if (!repoVersion) {
        consola.error(
          `Facet "${facetName}" in ${contractFilePath} does not specify a contract version (@custom:version).`
        )
        continue
      }

      consola.info(
        `Verifying facet "${facetName}" with address ${facetAddressLC}...`
      )

      // ──────────────────────────────────────────────────────────────
      // Case 1: Facet already exists in deploy log
      // ──────────────────────────────────────────────────────────────
      if (deployLogAddress) {
        if (deployLogAddress === facetAddressLC) {
          // Same address exists; compare versions if possible
          const onChainVersion = extractVersion(facetData.SourceCode)
          if (isVersionNewer(repoVersion, onChainVersion)) {
            consola.warn(
              `Facet "${facetName}": Newer version available in repo. On-chain version: ${onChainVersion}, Repo version: ${repoVersion}.`
            )
          } else {
            consola.success(
              `Facet "${facetName}": On-chain and deploy log addresses match and are up to date.`
            )
          }
        } else {
          // Addresses mismatch: compare versions and log discrepancies
          consola.error(
            `Facet "${facetName}": Address mismatch between on-chain (${facetAddressLC}) and deploy log (${deployLogAddress}). Checking versions...`
          )
          const deployLogData = await fetchContractDetails(
            baseUrl,
            deployLogAddress,
            network
          )
          const deployLogVersion = extractVersion(deployLogData.SourceCode)
          const onChainVersion = extractVersion(facetData.SourceCode)

          if (isVersionNewer(onChainVersion, deployLogVersion)) {
            consola.warn(
              `Facet "${facetName}": On-chain version ${showVersion(
                onChainVersion
              )} is newer than deploy log version ${showVersion(
                deployLogVersion
              )}. Updating deploy log (${deployLogAddress} → ${facetAddressLC}).`
            )
            networkDeployLogContracts[facetName] = facetAddressLC
            if (isVersionNewer(repoVersion, onChainVersion)) {
              consola.warn(
                `Facet "${facetName}": Repo version ${showVersion(
                  repoVersion
                )} is newer than on-chain version ${showVersion(
                  onChainVersion
                )}.`
              )
            }
          } else if (isVersionNewer(deployLogVersion, onChainVersion)) {
            consola.error(
              `Facet "${facetName}": Deploy log version ${showVersion(
                deployLogVersion
              )} is newer than on-chain version ${showVersion(
                onChainVersion
              )}. Please update the diamond with the newer version.`
            )
          } else {
            consola.error(
              `Facet "${facetName}": Both on-chain and deploy log versions are identical but addresses differ.`
            )
          }
        }
      } else {
        // ──────────────────────────────────────────────────────────────
        // Case 2: Facet missing in deploy log – add it!
        // ──────────────────────────────────────────────────────────────
        consola.warn(
          `Facet "${facetName}" is missing in deploy log. Adding with address ${facetAddressLC}.`
        )
        networkDeployLogContracts[facetName] = facetAddressLC
        const onChainVersion = extractVersion(facetData.SourceCode)
        if (isVersionNewer(repoVersion, onChainVersion)) {
          consola.warn(
            `Facet "${facetName}": Repo version ${showVersion(
              repoVersion
            )} is newer than on-chain version ${showVersion(onChainVersion)}.`
          )
        }
      }
    }

    // Write the updated deployment log back to disk
    fs.writeFileSync(
      networkDeploymentLogPath,
      JSON.stringify(networkDeployLogContracts, null, 2)
    )
  } catch (error) {
    consola.warn('Skipping facet registration check due to an error:')
    if (error instanceof Error) {
      consola.error(error.message)
    } else {
      consola.error(String(error))
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Utility Functions
// ──────────────────────────────────────────────────────────────

function findContractFile(
  baseDir: string,
  contractName: string
): string | null {
  const files = fs.readdirSync(baseDir, { withFileTypes: true })
  for (const file of files) {
    const filePath = path.join(baseDir, file.name)
    if (file.isDirectory()) {
      const found = findContractFile(filePath, contractName)
      if (found) return found
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
  await delay(1000)
  const apiKeyEnvVar = `${network.toUpperCase()}_ETHERSCAN_API_KEY`
  const apiKey = process.env[apiKeyEnvVar]
  if (!apiKey) {
    throw new Error(
      `Missing API key for ${network}. Please set ${apiKeyEnvVar} in your environment.`
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
      'Missing or unsupported chainid parameter. See https://api.etherscan.io/v2/chainlist for details.'
    )
    return null
  }
  return data.result[0] ?? null
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Extracts the version string from the contract source code using the @custom:version tag.
 * @param sourceCode Contract source code as a string.
 * @returns Version string (e.g. "1.2.3") or null if not found.
 */
function extractVersion(sourceCode: string): string | null {
  const versionMatch = sourceCode.match(/@custom:version\s+([\d.]+)/)
  return versionMatch ? versionMatch[1] : null
}

/**
 * Parses a version string into an array of numbers.
 */
function parseVersion(version: string): number[] {
  return version.split('.').map((num) => parseInt(num, 10) || 0)
}

/**
 * Compares two version strings.
 * Returns true if versionA is newer than versionB.
 */
function isVersionNewer(
  versionA: string | null,
  versionB: string | null
): boolean {
  if (versionA === null) return false
  if (versionB === null) return true

  const aParts = parseVersion(versionA)
  const bParts = parseVersion(versionB)
  for (let i = 0; i < 3; i++) {
    const a = aParts[i] || 0
    const b = bParts[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

/**
 * Formats a version string for display.
 */
function showVersion(version: string | null): string {
  return version === null ? "'No version'" : `'${version}'`
}

/**
 * Checks if a contract is deployed by verifying that its on-chain code is not empty.
 */
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
