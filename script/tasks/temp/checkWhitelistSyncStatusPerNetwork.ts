import { consola } from 'consola'
import {
  concat,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import 'dotenv/config'

import networksConfig from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type INetwork,
  type SupportedChain,
} from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getRPCEnvVarName } from '../../utils/network'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

// ABI for WhitelistManagerFacet
const WHITELIST_MANAGER_ABI = parseAbi([
  'function getAllContractSelectorPairs() view returns (address[],bytes4[][])',
  'function isContractSelectorWhitelisted(address,bytes4) view returns (bool)',
  'function getWhitelistedSelectorsForContract(address) view returns (bytes4[])',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

// ABI for Diamond Loupe (to check if selector is registered)
const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4) view returns (address)',
])

// Selector for batchSetContractSelectorWhitelist(address[],bytes4[],bool)
// Calculated using: cast sig "batchSetContractSelectorWhitelist(address[],bytes4[],bool)"
const BATCH_SET_CONTRACT_SELECTOR_WHITELIST_SELECTOR =
  '0x1171c007' as `0x${string}`

interface IWhitelistStatus {
  network: string
  environment: 'production' | 'staging'
  hasWhitelistManagerFacet: boolean | null // WhitelistManagerFacet is added to diamond
  selectorsMatch: boolean | null // V1 selectors == V2 selectors
  contractsMatch: boolean | null // V1 contracts == V2 contracts
  configMatches: boolean | null // getAllContractSelectorPairs == config pairs
  isFullySynced: boolean | null // All three conditions above are true
  errors: string[]
}

// Helper function to normalize address/selector to lowercase
function normalizePair(pair: string): string {
  return pair.toLowerCase()
}

// Helper function to parse getAllContractSelectorPairs result
function parseContractSelectorPairs(
  addresses: Address[],
  selectors: `0x${string}`[][]
): string[] {
  const pairs: string[] = []
  for (let i = 0; i < addresses.length; i++) {
    const contract = addresses[i]?.toLowerCase()
    if (!contract) continue
    const contractSelectors = selectors[i] || []
    for (const selector of contractSelectors) {
      pairs.push(`${contract}|${selector.toLowerCase()}`)
    }
  }
  return pairs
}

// Helper function to get config pairs from whitelist files
async function getConfigPairs(
  networkName: SupportedChain,
  environment: 'production' | 'staging'
): Promise<string[]> {
  const fs = await import('fs')
  const path = await import('path')

  const whitelistFile =
    environment === 'production'
      ? path.join(process.cwd(), 'config', 'whitelist.json')
      : path.join(process.cwd(), 'config', 'whitelist.staging.json')

  if (!fs.existsSync(whitelistFile)) {
    return []
  }

  const whitelistData = JSON.parse(fs.readFileSync(whitelistFile, 'utf8'))
  const pairs: string[] = []

  // Get DEX contracts
  // Matches bash script: .DEXS[] | select(.contracts[$network] != null) | .contracts[$network][] | select(.address != null) | "\(.address)|\(.functions | keys | join(","))"
  if (whitelistData.DEXS) {
    for (const dex of whitelistData.DEXS) {
      if (dex.contracts && dex.contracts[networkName]) {
        for (const contract of dex.contracts[networkName]) {
          if (contract.address) {
            const addressLower = contract.address.toLowerCase()
            // Skip address zero (forbidden) - matches bash script validation
            if (addressLower === '0x0000000000000000000000000000000000000000') {
              continue
            }
            const address = getAddress(contract.address).toLowerCase()
            if (
              contract.functions &&
              Object.keys(contract.functions).length > 0
            ) {
              const selectors = Object.keys(contract.functions)
              for (const selector of selectors) {
                pairs.push(`${address}|${selector.toLowerCase()}`)
              }
            } else {
              // No selectors or empty functions object - use ApproveTo-Only Selector (0xffffffff) - matches bash script
              pairs.push(`${address}|0xffffffff`)
            }
          }
        }
      }
    }
  }

  // Get PERIPHERY contracts
  // Matches bash script: .PERIPHERY[$network] // [] | .[] | select(.address != null) | "\(.address)|\(.selectors | map(.selector) | join(","))"
  if (whitelistData.PERIPHERY && whitelistData.PERIPHERY[networkName]) {
    for (const periphery of whitelistData.PERIPHERY[networkName]) {
      if (periphery.address) {
        const addressLower = periphery.address.toLowerCase()
        // Skip address zero (forbidden) - matches bash script validation
        if (addressLower === '0x0000000000000000000000000000000000000000') {
          continue
        }
        const address = getAddress(periphery.address).toLowerCase()
        if (periphery.selectors && Array.isArray(periphery.selectors)) {
          for (const sel of periphery.selectors) {
            if (sel.selector) {
              pairs.push(`${address}|${sel.selector.toLowerCase()}`)
            }
          }
        } else {
          // No selectors - use ApproveTo-Only Selector (0xffffffff) - matches bash script
          pairs.push(`${address}|0xffffffff`)
        }
      }
    }
  }

  return pairs
}

// Helper function to read V1 contracts from raw storage
async function readV1ContractsFromStorage(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address
): Promise<Address[]> {
  // Constants from LibAllowList storage layout
  const ALLOW_LIST_NAMESPACE =
    '0x7a8ac5d3b7183f220a0602439da45ea337311d699902d1ed11a3725a714e7f1e'
  const baseSlot = BigInt(ALLOW_LIST_NAMESPACE)
  const contractsLengthSlot = baseSlot + 2n

  // Read array length
  const contractsLengthHex = await publicClient.getStorageAt({
    address: diamondAddress,
    slot: toHex(contractsLengthSlot),
  })
  const contractsLength = parseInt(contractsLengthHex ?? '0x0', 16)

  if (contractsLength === 0) {
    return []
  }

  // Compute array base slot for elements
  const contractsBaseSlotHex = keccak256(
    pad(toHex(contractsLengthSlot), { size: 32 })
  )
  const contractsBaseSlot = BigInt(contractsBaseSlotHex)

  // Read contracts array
  const contracts: Address[] = []
  for (let i = 0; i < contractsLength; i++) {
    const elementSlot = BigInt(contractsBaseSlot) + BigInt(i)
    const elementHex = await publicClient.getStorageAt({
      address: diamondAddress,
      slot: toHex(elementSlot),
    })
    if (
      elementHex &&
      elementHex !==
        '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      // Extract address from storage (last 20 bytes, padded to 32 bytes)
      const address = (
        `0x${elementHex.slice(26)}` as Address
      ).toLowerCase() as Address
      contracts.push(address)
    }
  }

  return contracts
}

// Helper function to read V1 selectors from raw storage
async function readV1SelectorsFromStorage(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address
): Promise<`0x${string}`[]> {
  // Constants from LibAllowList storage layout
  const ALLOW_LIST_NAMESPACE =
    '0x7a8ac5d3b7183f220a0602439da45ea337311d699902d1ed11a3725a714e7f1e'
  const baseSlot = BigInt(ALLOW_LIST_NAMESPACE)
  const selectorsLengthSlot = baseSlot + 5n

  // Read array length
  const selectorsLengthHex = await publicClient.getStorageAt({
    address: diamondAddress,
    slot: toHex(selectorsLengthSlot),
  })
  const selectorsLength = parseInt(selectorsLengthHex ?? '0x0', 16)

  if (selectorsLength === 0) {
    return []
  }

  // Compute array base slot for elements
  const selectorsBaseSlotHex = keccak256(
    pad(toHex(selectorsLengthSlot), { size: 32 })
  )
  const selectorsBaseSlot = BigInt(selectorsBaseSlotHex)

  // Read selectors array
  const selectors: `0x${string}`[] = []
  for (let i = 0; i < selectorsLength; i++) {
    const elementSlot = BigInt(selectorsBaseSlot) + BigInt(i)
    const elementHex = await publicClient.getStorageAt({
      address: diamondAddress,
      slot: toHex(elementSlot),
    })
    if (
      elementHex &&
      elementHex !==
        '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      // Extract selector from storage (first 4 bytes, padded to 32 bytes)
      const selector = (
        `0x${elementHex.slice(2, 10)}` as `0x${string}`
      ).toLowerCase() as `0x${string}`
      // Filter out 0x00000000
      if (selector !== '0x00000000') {
        selectors.push(selector)
      }
    }
  }

  return selectors
}

// Helper function to extract unique selectors from V2 pairs
function extractV2Selectors(
  addresses: Address[],
  selectors: `0x${string}`[][]
): `0x${string}`[] {
  const uniqueSelectors = new Set<`0x${string}`>()
  for (let i = 0; i < addresses.length; i++) {
    const contractSelectors = selectors[i] || []
    for (const selector of contractSelectors) {
      const normalized = selector.toLowerCase() as `0x${string}`
      // Filter out 0x00000000
      if (normalized !== '0x00000000') {
        uniqueSelectors.add(normalized)
      }
    }
  }
  return Array.from(uniqueSelectors).sort()
}

// Helper function to check if WhitelistManagerFacet is registered on the diamond
async function checkWhitelistManagerFacetRegistered(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address
): Promise<boolean> {
  try {
    const facetAddress = await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_LOUPE_ABI,
      functionName: 'facetAddress',
      args: [BATCH_SET_CONTRACT_SELECTOR_WHITELIST_SELECTOR],
    })
    // If facetAddress is not zero address, the selector is registered
    return facetAddress !== '0x0000000000000000000000000000000000000000'
  } catch (error) {
    // If call fails, assume not registered
    return false
  }
}

// Helper function to read selectorAllowList mapping directly from raw storage
async function readV1SelectorsFromMapping(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address,
  selectorsToCheck: `0x${string}`[]
): Promise<`0x${string}`[]> {
  // Constants from LibAllowList storage layout
  const ALLOW_LIST_NAMESPACE =
    '0x7a8ac5d3b7183f220a0602439da45ea337311d699902d1ed11a3725a714e7f1e'
  const baseSlot = BigInt(ALLOW_LIST_NAMESPACE)
  const selectorAllowListSlot = baseSlot + 1n

  const approvedSelectors: `0x${string}`[] = []

  for (const selector of selectorsToCheck) {
    try {
      // Calculate storage slot for selectorAllowList[selector]
      // slot = keccak256(concat([selector (padded to 32 bytes, right-padded), baseSlot (padded to 32 bytes)]))
      const selectorPadded = pad(selector as Hex, { size: 32, dir: 'right' })
      const baseSlotPadded = pad(toHex(selectorAllowListSlot), { size: 32 })
      const slot = keccak256(concat([selectorPadded, baseSlotPadded]))

      // Read storage slot (keccak256 already returns Hex, no need for toHex)
      const storageValue = await publicClient.getStorageAt({
        address: diamondAddress,
        slot: slot,
      })

      // Check if value ends with '01' (true) - last byte is 0x01
      if (storageValue && storageValue.endsWith('01')) {
        approvedSelectors.push(selector)
      }
    } catch (error) {
      // Skip on error, but log it
      console.log(
        `  ⚠️  Failed to read selectorAllowList[${selector}] from storage: ${error}`
      )
      continue
    }
  }

  return approvedSelectors
}

async function checkNetworkWhitelistStatus(
  networkName: SupportedChain,
  networkConfig: INetwork,
  environment: 'production' | 'staging'
): Promise<IWhitelistStatus | null> {
  const status: IWhitelistStatus = {
    network: networkName,
    environment,
    hasWhitelistManagerFacet: null,
    selectorsMatch: null,
    contractsMatch: null,
    configMatches: null,
    isFullySynced: null,
    errors: [],
  }

  try {
    // Skip inactive networks
    if (networkConfig.status !== 'active') {
      status.errors.push(`Network is ${networkConfig.status}`)
      return status
    }

    // Get deployment addresses
    let diamondAddress: Address | null = null

    try {
      const deployments = await getDeployments(
        networkName,
        environment === 'production'
          ? EnvironmentEnum.production
          : EnvironmentEnum.staging
      )
      diamondAddress = deployments.LiFiDiamond
        ? (getAddress(deployments.LiFiDiamond) as Address)
        : null
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      status.errors.push(`Failed to load deployments: ${errorMessage}`)
    }

    if (!diamondAddress) {
      // Skip networks without deployed diamond - return null to filter out
      return null
    }

    // Get RPC URL
    const rpcEnvVarName = getRPCEnvVarName(networkName)
    const premiumRpcUrl = process.env[rpcEnvVarName]
    const rpcUrl = premiumRpcUrl || networkConfig.rpcUrl

    if (!rpcUrl) {
      status.errors.push('No RPC URL configured')
      return status
    }

    // Create public client
    const chain = getViemChainForNetworkName(networkName)
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Check if WhitelistManagerFacet is registered
    try {
      status.hasWhitelistManagerFacet =
        await checkWhitelistManagerFacetRegistered(publicClient, diamondAddress)
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      status.errors.push(
        `Failed to check WhitelistManagerFacet: ${errorMessage}`
      )
      status.hasWhitelistManagerFacet = false
    }

    // Get config pairs
    const configPairs = await getConfigPairs(networkName, environment)

    // Get V2 pairs from diamond
    try {
      const result = await publicClient.readContract({
        address: diamondAddress,
        abi: WHITELIST_MANAGER_ABI,
        functionName: 'getAllContractSelectorPairs',
      })

      const [v2Addresses, v2SelectorsArrays] = result as [
        Address[],
        `0x${string}`[][]
      ]

      // Extract V2 unique contracts and selectors
      const v2UniqueContracts = Array.from(
        new Set(v2Addresses.map((addr) => addr.toLowerCase() as Address))
      ).sort()
      const v2UniqueSelectors = extractV2Selectors(
        v2Addresses,
        v2SelectorsArrays
      )

      // Read V1 contracts from raw storage
      let v1ContractsFromArray: Address[] = []
      try {
        console.log(
          `[${networkName} (${environment})] 📖 Reading V1 contracts from storage (contracts[] array)...`
        )
        v1ContractsFromArray = await readV1ContractsFromStorage(
          publicClient,
          diamondAddress
        )
        console.log(
          `[${networkName} (${environment})] ✅ V1 contracts from array: ${v1ContractsFromArray.length}`
        )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.log(
          `[${networkName} (${environment})] ❌ Failed to read V1 contracts from storage: ${errorMessage}`
        )
        status.errors.push(
          `Failed to read V1 contracts from storage: ${errorMessage}`
        )
      }

      // Read V1 selectors from raw storage (selectors[] array)
      let v1SelectorsFromArray: `0x${string}`[] = []
      try {
        console.log(
          `[${networkName} (${environment})] 📖 Reading V1 selectors from storage (selectors[] array)...`
        )
        v1SelectorsFromArray = await readV1SelectorsFromStorage(
          publicClient,
          diamondAddress
        )
        console.log(
          `[${networkName} (${environment})] ✅ V1 selectors from array: ${v1SelectorsFromArray.length}`
        )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.log(
          `[${networkName} (${environment})] ❌ Failed to read V1 selectors from storage: ${errorMessage}`
        )
        status.errors.push(
          `Failed to read V1 selectors from storage: ${errorMessage}`
        )
      }

      // Read selectorAllowList mapping directly from raw storage for V2 selectors
      let v1SelectorsFromMapping: `0x${string}`[] = []
      try {
        console.log(
          `[${networkName} (${environment})] 🔍 Reading selectorAllowList mapping from raw storage for ${v2UniqueSelectors.length} V2 selectors...`
        )
        v1SelectorsFromMapping = await readV1SelectorsFromMapping(
          publicClient,
          diamondAddress,
          v2UniqueSelectors
        )
        console.log(
          `[${networkName} (${environment})] ✅ V1 selectors from mapping (raw storage): ${v1SelectorsFromMapping.length}`
        )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        console.log(
          `[${networkName} (${environment})] ❌ Failed to read selectorAllowList mapping from storage: ${errorMessage}`
        )
        status.errors.push(
          `Failed to read selectorAllowList mapping from storage: ${errorMessage}`
        )
      }

      // Combine V1 selectors from array and mapping
      console.log(
        `[${networkName} (${environment})] 🔗 Combining V1 selectors (array + mapping)...`
      )
      const v1SelectorsCombined = new Set<`0x${string}`>()
      for (const sel of v1SelectorsFromArray) {
        v1SelectorsCombined.add(sel)
      }
      for (const sel of v1SelectorsFromMapping) {
        v1SelectorsCombined.add(sel)
      }
      const v1SelectorsSorted = Array.from(v1SelectorsCombined).sort()
      console.log(
        `[${networkName} (${environment})] ✅ V1 selectors COMBINED (array + mapping): ${v1SelectorsSorted.length}`
      )

      // Compare V1 vs V2 contracts
      console.log(
        `[${networkName} (${environment})] ⚖️  Comparing V1 vs V2 contracts...`
      )
      const v1ContractsSorted = [...v1ContractsFromArray].sort()
      const contractsMatch =
        v1ContractsSorted.length === v2UniqueContracts.length &&
        v1ContractsSorted.every((addr, i) => addr === v2UniqueContracts[i])
      status.contractsMatch = contractsMatch
      if (contractsMatch) {
        console.log(
          `[${networkName} (${environment})] ✅ V1 and V2 contracts MATCH (${v1ContractsSorted.length} contracts)`
        )
      } else {
        console.log(
          `[${networkName} (${environment})] ⚠️  V1 and V2 contracts DO NOT MATCH (V1: ${v1ContractsSorted.length}, V2: ${v2UniqueContracts.length})`
        )

        // Show detailed comparison
        console.log(
          `\n[${networkName} (${environment})] 📋 Detailed Contract Comparison:`
        )
        console.log(
          `\n[${networkName} (${environment})] V1 contracts (${v1ContractsSorted.length}):`
        )

        const v2ContractsSet = new Set(v2UniqueContracts)
        for (const addr of v1ContractsSorted) {
          const inV2 = v2ContractsSet.has(addr)
          const status = inV2 ? '✅' : '❌'
          console.log(`  ${status} ${addr}`)
        }

        console.log(
          `\n[${networkName} (${environment})] V2 contracts (${v2UniqueContracts.length}):`
        )

        const v1ContractsSet = new Set(v1ContractsSorted)
        for (const addr of v2UniqueContracts) {
          const inV1 = v1ContractsSet.has(addr)
          const status = inV1 ? '✅' : '❌'
          console.log(`  ${status} ${addr}`)
        }

        // Summary of mismatches
        const v1NotInV2 = v1ContractsSorted.filter(
          (addr) => !v2ContractsSet.has(addr)
        )
        const v2NotInV1 = v2UniqueContracts.filter(
          (addr) => !v1ContractsSet.has(addr)
        )

        if (v1NotInV2.length > 0) {
          console.log(
            `\n[${networkName} (${environment})] ❌ V1 contracts NOT in V2 (${v1NotInV2.length}):`
          )
          for (const addr of v1NotInV2) {
            console.log(`  ${addr}`)
          }
        }

        if (v2NotInV1.length > 0) {
          console.log(
            `\n[${networkName} (${environment})] ❌ V2 contracts NOT in V1 (${v2NotInV1.length}):`
          )
          for (const addr of v2NotInV1) {
            console.log(`  ${addr}`)
          }
        }
      }

      // Compare V1 vs V2 selectors
      console.log(
        `[${networkName} (${environment})] ⚖️  Comparing V1 vs V2 selectors...`
      )
      const v2SelectorsSorted = [...v2UniqueSelectors].sort()
      const selectorsMatch =
        v1SelectorsSorted.length === v2SelectorsSorted.length &&
        v1SelectorsSorted.every((sel, i) => sel === v2SelectorsSorted[i])
      status.selectorsMatch = selectorsMatch
      if (selectorsMatch) {
        console.log(
          `[${networkName} (${environment})] ✅ V1 and V2 selectors MATCH (${v1SelectorsSorted.length} selectors)`
        )
      } else {
        console.log(
          `[${networkName} (${environment})] ⚠️  V1 and V2 selectors DO NOT MATCH (V1: ${v1SelectorsSorted.length}, V2: ${v2SelectorsSorted.length})`
        )

        // Show detailed comparison
        console.log(
          `\n[${networkName} (${environment})] 📋 Detailed Selector Comparison:`
        )
        console.log(
          `\n[${networkName} (${environment})] V1 selectors (${v1SelectorsSorted.length}):`
        )

        const v2SelectorsSet = new Set(v2SelectorsSorted)
        for (const sel of v1SelectorsSorted) {
          const inV2 = v2SelectorsSet.has(sel)
          const status = inV2 ? '✅' : '❌'
          console.log(`  ${status} ${sel}`)
        }

        console.log(
          `\n[${networkName} (${environment})] V2 selectors (${v2SelectorsSorted.length}):`
        )

        const v1SelectorsSet = new Set(v1SelectorsSorted)
        for (const sel of v2SelectorsSorted) {
          const inV1 = v1SelectorsSet.has(sel)
          const status = inV1 ? '✅' : '❌'
          console.log(`  ${status} ${sel}`)
        }

        // Summary of mismatches
        const v1NotInV2 = v1SelectorsSorted.filter(
          (sel) => !v2SelectorsSet.has(sel)
        )
        const v2NotInV1 = v2SelectorsSorted.filter(
          (sel) => !v1SelectorsSet.has(sel)
        )

        if (v1NotInV2.length > 0) {
          console.log(
            `\n[${networkName} (${environment})] ❌ V1 selectors NOT in V2 (${v1NotInV2.length}):`
          )
          for (const sel of v1NotInV2) {
            console.log(`  ${sel}`)
          }
        }

        if (v2NotInV1.length > 0) {
          console.log(
            `\n[${networkName} (${environment})] ❌ V2 selectors NOT in V1 (${v2NotInV1.length}):`
          )
          for (const sel of v2NotInV1) {
            console.log(`  ${sel}`)
          }
        }
      }

      // Compare getAllContractSelectorPairs with config pairs
      console.log(
        `[${networkName} (${environment})] ⚖️  Comparing getAllContractSelectorPairs with config pairs...`
      )
      const v2Pairs = parseContractSelectorPairs(v2Addresses, v2SelectorsArrays)
      const normalizedV2Pairs = v2Pairs.map(normalizePair)
      const normalizedConfigPairs = configPairs.map(normalizePair)

      // Check if V2 pairs match config pairs (same length and same elements)
      const configMatches =
        normalizedV2Pairs.length === normalizedConfigPairs.length &&
        normalizedV2Pairs.every((pair) =>
          normalizedConfigPairs.includes(pair)
        ) &&
        normalizedConfigPairs.every((pair) => normalizedV2Pairs.includes(pair))
      status.configMatches = configMatches

      if (configMatches) {
        console.log(
          `[${networkName} (${environment})] ✅ getAllContractSelectorPairs MATCHES config (${normalizedV2Pairs.length} pairs)`
        )
      } else {
        console.log(
          `[${networkName} (${environment})] ⚠️  getAllContractSelectorPairs DOES NOT MATCH config (V2: ${normalizedV2Pairs.length}, Config: ${normalizedConfigPairs.length})`
        )

        // Show detailed comparison
        console.log(
          `\n[${networkName} (${environment})] 📋 Detailed Comparison:`
        )
        console.log(
          `\n[${networkName} (${environment})] getAllContractSelectorPairs pairs (${normalizedV2Pairs.length}):`
        )

        // Sort both arrays for consistent display
        const sortedV2Pairs = [...normalizedV2Pairs].sort()
        const sortedConfigPairs = [...normalizedConfigPairs].sort()
        const configPairsSet = new Set(sortedConfigPairs)

        // Show V2 pairs with status
        for (const pair of sortedV2Pairs) {
          const inConfig = configPairsSet.has(pair)
          const status = inConfig ? '✅' : '❌'
          console.log(`  ${status} ${pair}`)
        }

        console.log(
          `\n[${networkName} (${environment})] Config pairs (${normalizedConfigPairs.length}):`
        )

        // Show config pairs with status
        const v2PairsSet = new Set(sortedV2Pairs)
        for (const pair of sortedConfigPairs) {
          const inV2 = v2PairsSet.has(pair)
          const status = inV2 ? '✅' : '❌'
          console.log(`  ${status} ${pair}`)
        }

        // Summary of mismatches
        const v2NotInConfig = sortedV2Pairs.filter(
          (p) => !configPairsSet.has(p)
        )
        const configNotInV2 = sortedConfigPairs.filter(
          (p) => !v2PairsSet.has(p)
        )

        if (v2NotInConfig.length > 0) {
          console.log(
            `\n[${networkName} (${environment})] ❌ V2 pairs NOT in config (${v2NotInConfig.length}):`
          )
          for (const pair of v2NotInConfig) {
            console.log(`  ${pair}`)
          }
        }

        if (configNotInV2.length > 0) {
          console.log(
            `\n[${networkName} (${environment})] ❌ Config pairs NOT in V2 (${configNotInV2.length}):`
          )
          for (const pair of configNotInV2) {
            console.log(`  ${pair}`)
          }
        }
      }
      console.log('') // Empty line for readability

      // Determine if fully synced (all conditions must be true, including WhitelistManagerFacet)
      status.isFullySynced =
        status.hasWhitelistManagerFacet === true &&
        status.selectorsMatch === true &&
        status.contractsMatch === true &&
        status.configMatches === true
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      const conciseError = extractConciseError(errorMessage)
      status.errors.push(`Whitelist check: ${conciseError}`)
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    status.errors.push(`Network check failed: ${errorMessage}`)
  }

  return status
}

function formatStatus(value: boolean | null): string {
  if (value === null) return '❓'
  return value ? '✅' : '❌'
}

function extractConciseError(errorMessage: string): string {
  if (errorMessage.includes('Unauthorized')) {
    return 'RPC auth required'
  }
  if (errorMessage.includes('HTTP request failed')) {
    if (errorMessage.includes('403')) {
      return 'RPC unavailable (403)'
    }
    if (errorMessage.includes('Blast API')) {
      return 'RPC deprecated'
    }
    return 'RPC request failed'
  }
  if (errorMessage.includes('Unexpected end of JSON')) {
    return 'RPC response error'
  }
  if (errorMessage.includes('fetch failed')) {
    return 'Network error'
  }
  return errorMessage.length > 60
    ? `${errorMessage.substring(0, 57)}...`
    : errorMessage
}

function getColorCode(color: 'red' | 'green' | 'yellow' | 'reset'): string {
  const codes = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m',
  }
  return codes[color]
}

function printTable(results: IWhitelistStatus[]) {
  // Calculate column widths
  const networkWidth = Math.max(
    'Network'.length,
    ...results.map((r) => `${r.network} (${r.environment})`.length)
  )
  const colWidth = 8

  // Legend above table
  console.log('\n')
  console.log('Legend:')
  console.log(
    '  0: WhitelistManagerFacet Registered (batchSetContractSelectorWhitelist selector exists)'
  )
  console.log('  1: V1 vs V2 Selectors Match (V1 selectors == V2 selectors)')
  console.log('  2: V1 vs V2 Contracts Match (V1 contracts == V2 contracts)')
  console.log(
    '  3: Config Matches (getAllContractSelectorPairs == config pairs)'
  )
  console.log('  4: Fully Synced (all conditions above are true)')
  console.log('')

  // Header
  const numColumns = 5
  const centerInColumn = (
    content: string,
    width: number,
    isEmoji = false
  ): string => {
    const visualWidth = isEmoji ? 2 : content.length
    const padding = width - visualWidth
    const leftPad = Math.floor(padding / 2)
    const rightPad = padding - leftPad
    return ' '.repeat(leftPad) + content + ' '.repeat(rightPad)
  }

  const headerCols = Array.from({ length: numColumns }, (_, i) =>
    centerInColumn(String(i), colWidth, false)
  ).join(' | ')
  const headerLine = `${'Network'.padEnd(networkWidth)} | ${headerCols}`
  console.log(headerLine)
  console.log('-'.repeat(headerLine.length))

  // Rows
  for (const result of results) {
    const allDone = result.isFullySynced === true && result.errors.length === 0

    const networkColor = allDone
      ? 'green'
      : result.errors.length > 0
      ? 'red'
      : 'yellow'
    const networkName = `${result.network} (${result.environment})`.padEnd(
      networkWidth
    )

    const hasFacet = centerInColumn(
      formatStatus(result.hasWhitelistManagerFacet),
      colWidth,
      true
    )
    const selectorsMatch = centerInColumn(
      formatStatus(result.selectorsMatch),
      colWidth,
      true
    )
    const contractsMatch = centerInColumn(
      formatStatus(result.contractsMatch),
      colWidth,
      true
    )
    const configMatches = centerInColumn(
      formatStatus(result.configMatches),
      colWidth,
      true
    )
    const synced = centerInColumn(
      formatStatus(result.isFullySynced),
      colWidth,
      true
    )

    const line = `${getColorCode(networkColor)}${networkName}${getColorCode(
      'reset'
    )} | ${hasFacet} | ${selectorsMatch} | ${contractsMatch} | ${configMatches} | ${synced}`

    console.log(line)
  }

  // Summary
  const allDoneCount = results.filter(
    (r) => r.isFullySynced === true && r.errors.length === 0
  ).length

  console.log('-'.repeat(headerLine.length))
  console.log('')
  console.log('Legend:')
  console.log(
    '  0: WhitelistManagerFacet Registered (batchSetContractSelectorWhitelist selector exists)'
  )
  console.log('  1: V1 vs V2 Selectors Match (V1 selectors == V2 selectors)')
  console.log('  2: V1 vs V2 Contracts Match (V1 contracts == V2 contracts)')
  console.log(
    '  3: Config Matches (getAllContractSelectorPairs == config pairs)'
  )
  console.log('  4: Fully Synced (all conditions above are true)')
  console.log('')
  console.log('Summary:')
  console.log(
    `  ${getColorCode('green')}✅ Fully synced: ${allDoneCount}${getColorCode(
      'reset'
    )}`
  )
  console.log(
    `  ${getColorCode('yellow')}⚠️  Needs sync: ${
      results.length - allDoneCount
    }${getColorCode('reset')}`
  )

  // Show networks with errors separately
  const networksWithErrors = results.filter((r) => r.errors.length > 0)
  if (networksWithErrors.length > 0) {
    console.log(
      `  ${getColorCode('red')}❓ With errors: ${
        networksWithErrors.length
      }${getColorCode('reset')}`
    )
    console.log('')
    console.log('Networks with errors (check RPC connectivity):')
    for (const result of networksWithErrors) {
      const firstError = result.errors[0]
      if (firstError) {
        const conciseError = extractConciseError(firstError)
        console.log(
          `  ${getColorCode('red')}${result.network} (${
            result.environment
          }): ${conciseError}${getColorCode('reset')}`
        )
      }
    }
  }
  console.log('\n')
}

async function main() {
  consola.info('Starting whitelist sync status check...')

  const networks = networksConfig as Record<string, Partial<INetwork>>
  const results: IWhitelistStatus[] = []

  // Filter to only valid SupportedChain networks
  const validNetworkNames = Object.keys(networks).filter(
    (name): name is SupportedChain => name in networks
  )

  // Process networks in parallel with concurrency limit
  const networkNames = validNetworkNames.filter(
    (name) => networks[name]?.status === 'active'
  )

  consola.info(
    `Checking ${networkNames.length} active networks (production + staging)...`
  )

  // Process all networks for both production and staging
  const networkPromises: Promise<IWhitelistStatus | null>[] = []

  for (const networkName of networkNames) {
    const networkConfig = networks[networkName]
    if (!networkConfig) {
      // Skip networks without config - they won't have deployed diamond anyway
      // Don't add them to promises
    } else {
      networkPromises.push(
        checkNetworkWhitelistStatus(
          networkName as SupportedChain,
          networkConfig as INetwork,
          'production'
        )
      )
      networkPromises.push(
        checkNetworkWhitelistStatus(
          networkName as SupportedChain,
          networkConfig as INetwork,
          'staging'
        )
      )
    }
  }

  const networkResults = await Promise.all(networkPromises)
  // Filter out null results (networks without deployed diamond)
  const validResults = networkResults.filter(
    (r): r is IWhitelistStatus => r !== null
  )
  results.push(...validResults)

  // Sort results: synced first, then by network name, then by environment
  results.sort((a, b) => {
    const aDone = a.isFullySynced === true && a.errors.length === 0
    const bDone = b.isFullySynced === true && b.errors.length === 0

    if (aDone !== bDone) return aDone ? 1 : -1
    if (a.network !== b.network) return a.network.localeCompare(b.network)
    if (a.environment !== b.environment) {
      return a.environment === 'production' ? -1 : 1
    }
    return 0
  })

  printTable(results)
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    consola.error('Fatal error:', error)
    process.exit(1)
  })
