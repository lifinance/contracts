import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as path from 'path'
import * as fs from 'fs'
import toml from 'toml'
import { Address, PublicClient, createPublicClient, http } from 'viem'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'
import Table from 'cli-table3'
import chalk from 'chalk'

// ──────────────────────────────────────────────────────────────
// Interface for facet report information
// ──────────────────────────────────────────────────────────────

interface FacetReport {
  facet: string
  onChain: string
  deployLog: string
  status: string
  message: string
}

const facetReports: FacetReport[] = [] // Global array to store each facet's report

// ──────────────────────────────────────────────────────────────
// Main Command Definition
// ──────────────────────────────────────────────────────────────

const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Deployment File Update',
    description:
      'Updates the deployment file to match the latest on-chain state and prints a summary table report.',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
    onlyIssues: {
      type: 'boolean',
      description:
        'If true, only facets with status ERROR or WARN are displayed in the final report',
      default: false,
    },
  },
  async run({ args }) {
    // ──────────────────────────────────────────────────────────────
    // INITIAL SETUP
    // ──────────────────────────────────────────────────────────────
    const { default: networksConfig } = await import(
      '../../config/networks.json'
    )
    type NetworkName = keyof typeof networksConfig
    let { network } = args
    network = network.toLowerCase() as NetworkName
    const { onlyIssues } = args

    consola.info(
      `\n=== Starting Update Process for Network: ${network.toUpperCase()} ===\n`
    )

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

    const { default: networkDeployLogContracts } = (await import(
      networkDeploymentLogPath
    )) as { default: Record<string, Address> }
    const { default: networkDiamondDeployLogContracts } = (await import(
      networkDiamondDeploymentLogPath
    )) as { default: Record<string, Address> }

    const chain = getViemChainForNetworkName(network)
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    // ──────────────────────────────────────────────────────────────
    // STEP 1: Check LiFiDiamond Deployment
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
    // STEP 2: Verify and Update Facet Registrations
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

    // ──────────────────────────────────────────────────────────────
    // PRINT SUMMARY REPORT TABLE (apply filtering if needed)
    // ──────────────────────────────────────────────────────────────
    printFacetReportTable(onlyIssues)

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
    // Load configuration from foundry.toml for Etherscan details
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

    // Retrieve facets from the diamond contract
    const facetsCmd =
      await $`cast call ${diamondAddress} "facets() returns ((address,bytes4[])[])" --rpc-url ${rpcUrl}`
    const rawFacetsData = facetsCmd.stdout
    const jsonCompatibleString = rawFacetsData
      .replace(/\(/g, '[')
      .replace(/\)/g, ']')
      .replace(/0x[0-9a-fA-F]+/g, '"$&"')
    const onChainFacets = JSON.parse(jsonCompatibleString)
    if (!Array.isArray(onChainFacets)) {
      throw new Error('Unexpected format for on-chain facets data.')
    }

    // Process each on-chain facet
    for (const [facetAddress] of onChainFacets) {
      const facetAddressLC = facetAddress.toLowerCase()
      let facetName = ''
      let deployLogAddress = ''
      let status = ''
      let message = ''

      // Fetch facet details via Etherscan API
      const facetData = await fetchContractDetails(
        baseUrl,
        facetAddressLC,
        network
      )
      facetName = facetData?.ContractName || ''

      if (!facetName) {
        message += `No contract name found (might be unverified). `
        const foundName = Object.keys(networkDeployLogContracts).find(
          (name) =>
            networkDeployLogContracts[name].toLowerCase() === facetAddressLC
        )
        if (!foundName) {
          message += `Facet not found in deploy log. Please verify and run again.`
          status = 'ERROR'
          facetReports.push({
            facet: 'Unknown',
            onChain: facetAddressLC,
            deployLog: 'N/A',
            status,
            message,
          })
          continue
        } else {
          message += `Contract name "${foundName}" found in deploy log; contract needs verification. `
          facetName = foundName
          status = 'INFO'
        }
      }

      deployLogAddress =
        networkDeployLogContracts[facetName]?.toLowerCase() || 'N/A'

      // Locate the contract source file in the project
      const contractFilePath = findContractFile('src', facetName)
      if (!contractFilePath) {
        message += `Contract file not found in src/; `
        const archivePath = findContractFile('archive', facetName)
        if (archivePath) {
          message += `file found in archive/ – remove facet from diamond.`
        }
        status = 'ERROR'
        facetReports.push({
          facet: facetName,
          onChain: facetAddressLC,
          deployLog: deployLogAddress,
          status,
          message,
        })
        continue
      }

      // Read source code to extract the repo version
      const contractSource = fs.readFileSync(contractFilePath, 'utf8')
      const repoVersion = extractVersion(contractSource)
      if (!repoVersion) {
        message += `No contract version (@custom:version) specified in source. `
        status = 'ERROR'
        facetReports.push({
          facet: facetName,
          onChain: facetAddressLC,
          deployLog: deployLogAddress,
          status,
          message,
        })
        continue
      }

      // Begin verification and comparison process
      message += `Contract "${facetName}": `
      if (deployLogAddress !== 'N/A') {
        if (deployLogAddress === facetAddressLC) {
          // Addresses match; check version differences if any
          const onChainVersion = extractVersion(facetData.SourceCode)
          if (isVersionNewer(repoVersion, onChainVersion)) {
            message += `Repo version (${repoVersion}) is newer than on-chain (${
              onChainVersion || 'none'
            }). `
            status = 'WARN'
          } else {
            message += `On-chain and deploy log addresses match and are up to date. `
            status = 'SUCCESS'
          }
        } else {
          // Mismatched addresses: compare versions and indicate necessary action
          message += `Address mismatch: on-chain (${facetAddressLC}) vs deploy log (${deployLogAddress}). `
          const deployLogData = await fetchContractDetails(
            baseUrl,
            deployLogAddress,
            network
          )
          const deployLogVersion = extractVersion(deployLogData.SourceCode)
          const onChainVersion = extractVersion(facetData.SourceCode)
          if (isVersionNewer(onChainVersion, deployLogVersion)) {
            message += `On-chain version (${
              onChainVersion || 'none'
            }) is newer. Updating deploy log. `
            networkDeployLogContracts[facetName] = facetAddressLC
            status = 'WARN'
          } else if (isVersionNewer(deployLogVersion, onChainVersion)) {
            message += `Deploy log version (${deployLogVersion}) is newer than on-chain (${
              onChainVersion || 'none'
            }). Please update the diamond. `
            status = 'ERROR'
          } else {
            message += `Versions identical but addresses differ. `
            status = 'ERROR'
          }
        }
      } else {
        // Facet is missing in deploy log; add it and warn if version difference exists
        message += `Facet missing in deploy log. Adding facet with address ${facetAddressLC}. `
        networkDeployLogContracts[facetName] = facetAddressLC
        const onChainVersion = extractVersion(facetData.SourceCode)
        if (isVersionNewer(repoVersion, onChainVersion)) {
          message += `Repo version (${repoVersion}) is newer than on-chain (${
            onChainVersion || 'none'
          }). `
          status = 'WARN'
        } else {
          status = 'INFO'
        }
      }

      // Add the result for this facet to the report array
      facetReports.push({
        facet: facetName,
        onChain: facetAddressLC,
        deployLog: deployLogAddress,
        status,
        message: message.trim(),
      })
    }

    // ──────────────────────────────────────────────────────────────
    // Check deploy log for facets missing on-chain.
    // Only add an error for entries with "Facet" in the name and which have not been reported.
    // Additionally, check if the contract is in src/ or in archive.
    // ──────────────────────────────────────────────────────────────
    const onChainFacetAddresses = new Set(
      onChainFacets.map(([addr]) => addr.toLowerCase())
    )
    for (const facetName in networkDeployLogContracts) {
      if (facetName === 'LiFiDiamond' || !facetName.includes('Facet')) continue
      if (facetReports.some((report) => report.facet === facetName)) continue
      const deployAddress = networkDeployLogContracts[facetName].toLowerCase()
      if (!onChainFacetAddresses.has(deployAddress)) {
        // First, check if the contract file exists in src
        const srcPath = findContractFile('src', facetName)
        if (srcPath) {
          const contractSource = fs.readFileSync(srcPath, 'utf8')
          const repoVersion = extractVersion(contractSource)
          facetReports.push({
            facet: facetName,
            onChain: 'N/A',
            deployLog: deployAddress,
            status: 'ERROR',
            message: `Facet "${facetName}" is in deploy log but not registered on-chain. Contract is in src with repo version (${
              repoVersion || 'unknown'
            }). Please register facet to diamond with the latest version.`,
          })
        } else {
          // If not in src, check archive folder
          const archivePath = findContractFile('archive', facetName)
          if (archivePath) {
            facetReports.push({
              facet: facetName,
              onChain: 'N/A',
              deployLog: deployAddress,
              status: 'ERROR',
              message: `Facet "${facetName}" is in deploy log but not registered on-chain. Contract is in archive; it can be removed from the deploy log completely.`,
            })
          } else {
            facetReports.push({
              facet: facetName,
              onChain: 'N/A',
              deployLog: deployAddress,
              status: 'ERROR',
              message: `Facet "${facetName}" is in deploy log but not registered on-chain. Please update the deployment file or register facet to diamond.`,
            })
          }
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
  consola.info(`Fetching details for contract at address: ${contractAddress}`)
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

function extractVersion(sourceCode: string): string | null {
  const versionMatch = sourceCode.match(/@custom:version\s+([\d.]+)/)
  return versionMatch ? versionMatch[1] : null
}

function parseVersion(version: string): number[] {
  return version.split('.').map((num) => parseInt(num, 10) || 0)
}

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

// ──────────────────────────────────────────────────────────────
// Reporting: Print a Terminal Table of Facet Verification Results
// ──────────────────────────────────────────────────────────────

function printFacetReportTable(filterOnlyIssues = false) {
  const table = new Table({
    head: [
      'Facet',
      'On-Chain Address',
      'Deploy Log Address',
      'Status',
      'Action / Description',
    ],
    colWidths: [20, 42, 42, 12, 60],
    wordWrap: true,
  })

  facetReports.forEach((report) => {
    if (
      filterOnlyIssues &&
      report.status !== 'ERROR' &&
      report.status !== 'WARN'
    ) {
      return
    }
    let coloredStatus = report.status
    if (report.status === 'ERROR') {
      coloredStatus = chalk.red(report.status)
    } else if (report.status === 'WARN') {
      coloredStatus = chalk.yellow(report.status)
    } else if (report.status === 'SUCCESS') {
      coloredStatus = chalk.green(report.status)
    }
    table.push([
      report.facet,
      report.onChain,
      report.deployLog,
      coloredStatus,
      report.message,
    ])
  })

  console.log('\n=== Facet Verification Report ===\n')
  console.log(table.toString())
}

runMain(main)
