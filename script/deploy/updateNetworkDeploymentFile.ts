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
// Interfaces and Types
// ──────────────────────────────────────────────────────────────

interface FacetReport {
  facet: string
  onChain: string
  deployLog: string
  diamondDeployLog?: string // Only used for diamond verification
  status: string
  message: string
}

type DeployLogContracts = Record<string, Address>

interface DiamondDeployLog {
  LiFiDiamond: {
    Facets: Record<string, { Name: string; Version: string }>
    Periphery: Record<string, string>
  }
}

// Separate report arrays for two processes.
const onChainReports: FacetReport[] = [] // Process 1: On-Chain vs. Deploy Log
const diamondReports: FacetReport[] = [] // Process 2: Diamond File vs. Deploy Log

// ──────────────────────────────────────────────────────────────
// Main Command Definition
// ──────────────────────────────────────────────────────────────

const main = defineCommand({
  meta: {
    name: 'LIFI Deployment Verification',
    description:
      'Verifies that on-chain facet data and diamond registry are consistent with the deploy log ({network}.json).',
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
        'If true, only rows with status ERROR or WARN are displayed in the final reports',
      default: false,
    },
  },
  async run({ args }) {
    // INITIAL SETUP
    const { default: networksConfig } = await import(
      '../../config/networks.json'
    )
    type NetworkName = keyof typeof networksConfig
    let { network } = args
    network = network.toLowerCase() as NetworkName
    const { onlyIssues } = args

    consola.info(
      `\n=== Starting Verification Process for Network: ${network.toUpperCase()} ===\n`
    )

    const networkDeployLogPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.json`
    )
    const networkDiamondLogPath = path.resolve(
      __dirname,
      '../../deployments/',
      `${network}.diamond.json`
    )

    const { default: networkDeployLogContracts } = (await import(
      networkDeployLogPath
    )) as { default: DeployLogContracts }
    const { default: networkDiamondLog } = (await import(
      networkDiamondLogPath
    )) as { default: DiamondDeployLog }

    const chain = getViemChainForNetworkName(network)
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    // STEP 1: Check LiFiDiamond deployment.
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

    // STEP 2: Verify on-chain facets vs. regular deploy log ({network}.json).
    consola.box('Step 2: Verifying On-Chain Facets vs. Deploy Log')
    $.quiet = true
    await verifyOnChainAgainstDeployLog({
      network,
      diamondAddress,
      networkDeployLogContracts,
      networksConfig,
    })

    // STEP 3: Verify diamond file facets vs. regular deploy log.
    consola.box('Step 3: Verifying Diamond File vs. Deploy Log')
    await verifyDiamondAgainstDeployLog({
      network,
      networkDeployLogContracts,
      networkDiamondLog,
    })

    // STEP 4: Verify periphery contracts (diamond vs. deploy log).
    consola.box('Step 4: Verifying Periphery Contracts')
    await verifyPeriphery({
      network,
      networkDeployLogContracts,
      networkDiamondLog,
    })

    // Print two separate report tables.
    printReportTable(
      onChainReports,
      'On-Chain vs. Deploy Log Verification',
      false,
      onlyIssues
    )
    printReportTable(
      diamondReports,
      'Diamond File vs. Deploy Log Verification',
      true,
      onlyIssues
    )

    consola.success('\n=== Verification Process Completed ===\n')
  },
})

// ──────────────────────────────────────────────────────────────
// Process 1: Verify On-Chain Facets vs. Regular Deploy Log ({network}.json)
// This report shows two address columns: On-Chain Address and Deploy Log Address.
interface OnChainParams {
  network: string
  diamondAddress: Address
  networkDeployLogContracts: DeployLogContracts
  networksConfig: any
}
async function verifyOnChainAgainstDeployLog({
  network,
  diamondAddress,
  networkDeployLogContracts,
  networksConfig,
}: OnChainParams) {
  try {
    const foundryTomlPath = path.resolve(__dirname, '../../foundry.toml')
    const foundryTomlContent = fs.readFileSync(foundryTomlPath, 'utf8')
    const foundryConfig = toml.parse(foundryTomlContent)
    const etherscanConfig = foundryConfig.etherscan[network]
    if (!etherscanConfig)
      throw new Error(
        `Etherscan configuration not found for network: ${network}`
      )
    const baseUrl = etherscanConfig.url
    const rpcUrl: string = networksConfig[network].rpcUrl
    if (!rpcUrl) throw new Error(`RPC URL not found for network: ${network}`)

    // Get on-chain facets.
    const facetsCmd =
      await $`cast call ${diamondAddress} "facets() returns ((address,bytes4[])[])" --rpc-url ${rpcUrl}`
    const rawData = facetsCmd.stdout
    const jsonStr = rawData
      .replace(/\(/g, '[')
      .replace(/\)/g, ']')
      .replace(/0x[0-9a-fA-F]+/g, '"$&"')
    const onChainFacets: string[][] = JSON.parse(jsonStr)
    if (!Array.isArray(onChainFacets))
      throw new Error('Unexpected on-chain facets format.')

    for (const [facetAddress] of onChainFacets) {
      const onChainAddr = facetAddress.toLowerCase()
      let facetName = ''
      let deployLogAddr = ''
      let status = ''
      let message = ''

      const facetData = await fetchContractDetails(
        baseUrl,
        onChainAddr,
        network
      )
      facetName = facetData?.ContractName || ''
      if (!facetName) {
        const foundName = Object.keys(networkDeployLogContracts).find(
          (name) =>
            networkDeployLogContracts[name].toLowerCase() === onChainAddr
        )
        if (!foundName) {
          message += `No contract name on-chain and not found in deploy log.`
          status = 'ERROR'
          onChainReports.push({
            facet: 'Unknown',
            onChain: onChainAddr,
            deployLog: 'N/A',
            status,
            message,
          })
          continue
        } else {
          facetName = foundName
          message += `Assumed contract name "${facetName}" from deploy log. `
          status = 'INFO'
        }
      }
      deployLogAddr =
        networkDeployLogContracts[facetName]?.toLowerCase() || 'N/A'

      // Get repo version from src.
      const srcPath = findContractFile('src', facetName)
      if (!srcPath) {
        message += `Contract file not found in src/.`
        status = 'ERROR'
        onChainReports.push({
          facet: facetName,
          onChain: onChainAddr,
          deployLog: deployLogAddr,
          status,
          message,
        })
        continue
      }
      const repoSource = fs.readFileSync(srcPath, 'utf8')
      const repoVersion = extractVersion(repoSource)
      if (!repoVersion) {
        message += `Repo version missing in source.`
        status = 'ERROR'
        onChainReports.push({
          facet: facetName,
          onChain: onChainAddr,
          deployLog: deployLogAddr,
          status,
          message,
        })
        continue
      }

      message += `Facet "${facetName}": `
      if (deployLogAddr === onChainAddr) {
        const onChainVersion = extractVersion(facetData.SourceCode) || 'none'
        if (isVersionNewer(repoVersion, onChainVersion)) {
          message += `Repo version (${repoVersion}) is newer than on-chain (${onChainVersion}).`
          status = 'WARN'
        } else {
          message += `Addresses match and versions are consistent.`
          status = 'SUCCESS'
        }
      } else {
        message += `Address mismatch: on-chain (${onChainAddr}) vs deploy log (${deployLogAddr}). `
        const deployLogData = await fetchContractDetails(
          baseUrl,
          deployLogAddr,
          network
        )
        const deployLogVersion =
          extractVersion(deployLogData?.SourceCode) || 'none'
        const onChainVersion = extractVersion(facetData.SourceCode) || 'none'
        if (isVersionNewer(onChainVersion, deployLogVersion)) {
          message += `On-chain version (${onChainVersion}) is newer than deploy log version (${deployLogVersion}). Please update the deploy log.`
          status = 'ERROR'
        } else if (isVersionNewer(deployLogVersion, onChainVersion)) {
          message += `Deploy log version (${deployLogVersion}) is newer than on-chain version (${onChainVersion}). Please register facet from deploy log.`
          status = 'ERROR'
        } else {
          message += `Versions identical but addresses differ. Please reconcile.`
          status = 'ERROR'
        }
      }
      onChainReports.push({
        facet: facetName,
        onChain: onChainAddr,
        deployLog: deployLogAddr,
        status,
        message: message.trim(),
      })
    }
  } catch (error) {
    consola.error(
      'Error in on-chain verification:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

// ──────────────────────────────────────────────────────────────
// Process 2: Verify Diamond File vs. Deploy Log
// In this process, we do not need an on-chain address column.
// Instead, we show the Diamond Log Address (from {network}.diamond.json) and compare it with the deploy log.
// ──────────────────────────────────────────────────────────────

interface DiamondParams {
  network: string
  networkDeployLogContracts: DeployLogContracts
  networkDiamondLog: DiamondDeployLog
}
async function verifyDiamondAgainstDeployLog({
  network,
  networkDeployLogContracts,
  networkDiamondLog,
}: DiamondParams) {
  try {
    // For facets: iterate over diamond file facets.
    const diamondFacets = networkDiamondLog.LiFiDiamond.Facets
    for (const addr in diamondFacets) {
      const diamondAddr = addr.toLowerCase()
      const facetInfo = diamondFacets[addr]
      const facetName = facetInfo.Name || '(unknown)'
      const deployLogAddr =
        networkDeployLogContracts[facetName]?.toLowerCase() || 'N/A'
      let status = ''
      let message = ''

      if (deployLogAddr === diamondAddr) {
        if (facetInfo.Version.trim() === '') {
          message += `Diamond file version is empty; facet may be unverified.`
          status = 'WARN'
        } else {
          message += `Facet "${facetName}" matches between diamond file and deploy log.`
          status = 'SUCCESS'
        }
      } else {
        message += `Address mismatch for facet "${facetName}": diamond file shows (${diamondAddr}) vs deploy log (${deployLogAddr}).`
        status = 'ERROR'
      }
      diamondReports.push({
        facet: facetName,
        onChain: 'N/A',
        deployLog: deployLogAddr,
        diamondDeployLog: diamondAddr,
        status,
        message: message.trim(),
      })
    }

    // For periphery: compare addresses.
    const diamondPeriphery = networkDiamondLog.LiFiDiamond.Periphery
    for (const key in diamondPeriphery) {
      const diamondPeriphAddr = diamondPeriphery[key].toLowerCase()
      const deployLogPeriphAddr =
        networkDeployLogContracts[key]?.toLowerCase() || 'N/A'
      let status = ''
      let message = ''
      if (deployLogPeriphAddr === diamondPeriphAddr) {
        status = 'SUCCESS'
        message = `Periphery contract "${key}" matches.`
      } else {
        status = 'ERROR'
        message = `Periphery contract "${key}" mismatch: diamond (${diamondPeriphAddr}) vs deploy log (${deployLogPeriphAddr}).`
      }
      diamondReports.push({
        facet: key,
        onChain: 'N/A',
        deployLog: deployLogPeriphAddr,
        diamondDeployLog: diamondPeriphAddr,
        status,
        message,
      })
    }
  } catch (error) {
    consola.error(
      'Error in diamond verification:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

// ──────────────────────────────────────────────────────────────
// Process 3: (Optional) Verify Periphery (if not merged above)
// In this solution, periphery checks are already handled in verifyDiamondAgainstDeployLog.
// ──────────────────────────────────────────────────────────────
interface VerifyPeripheryParams {
  network: string
  networkDeployLogContracts: DeployLogContracts
  networkDiamondLog: DiamondDeployLog
}
async function verifyPeriphery({
  network,
  networkDeployLogContracts,
  networkDiamondLog,
}: VerifyPeripheryParams) {
  return
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
  if (!apiKey)
    throw new Error(
      `Missing API key for ${network}. Please set ${apiKeyEnvVar} in your environment.`
    )
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
  networkDeployLogContracts: DeployLogContracts,
  publicClient: PublicClient
): Promise<boolean> => {
  const address = networkDeployLogContracts[contract]
  if (!address) return false
  const code = await publicClient.getCode({ address })
  return code !== '0x'
}

// ──────────────────────────────────────────────────────────────
// Reporting: Print a Terminal Table of Verification Results
// For Process 1 (on-chain vs deploy log), we show: Facet, On-Chain Address, Deploy Log Address, Status, Action/Description.
// For Process 2 (diamond vs deploy log), we show: Facet, Diamond Log Address, Deploy Log Address, Status, Action/Description.
// Column widths are set accordingly.
// ──────────────────────────────────────────────────────────────

function printReportTable(
  reportArray: FacetReport[],
  title: string,
  includeDiamond: boolean,
  filterOnlyIssues = false
) {
  let head: string[]
  let colWidths: number[]
  if (includeDiamond) {
    // For diamond verification: no on-chain column; show Diamond Log Address instead.
    head = [
      'Facet',
      'Diamond Log Address',
      'Deploy Log Address',
      'Status',
      'Action / Description',
    ]
    colWidths = [40, 55, 55, 10, 60]
  } else {
    head = [
      'Facet',
      'On-Chain Address',
      'Deploy Log Address',
      'Status',
      'Action / Description',
    ]
    colWidths = [25, 60, 60, 15, 80]
  }
  const table = new Table({ head, colWidths, wordWrap: true })

  reportArray.forEach((report) => {
    if (
      filterOnlyIssues &&
      report.status !== 'ERROR' &&
      report.status !== 'WARN'
    )
      return
    let coloredStatus = report.status
    if (report.status === 'ERROR') coloredStatus = chalk.red(report.status)
    else if (report.status === 'WARN')
      coloredStatus = chalk.yellow(report.status)
    else if (report.status === 'SUCCESS')
      coloredStatus = chalk.green(report.status)
    if (includeDiamond) {
      table.push([
        report.facet,
        report.diamondDeployLog || 'N/A',
        report.deployLog,
        coloredStatus,
        report.message,
      ])
    } else {
      table.push([
        report.facet,
        report.onChain,
        report.deployLog,
        coloredStatus,
        report.message,
      ])
    }
  })

  consola.info(`\n=== ${title} ===\n`)
  console.log(table.toString())
}

runMain(main)
