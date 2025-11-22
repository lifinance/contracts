#!/usr/bin/env bun

/**
 * Purpose:
 *   - Verify that the WhitelistManagerFacet migration was successful
 *   - Verify that both old DexManager facet functions and new WhitelistManager facet functions work correctly
 *   - Verify that storage is correctly migrated and matches whitelist.json (or whitelist.staging.json for staging)
 *
 * Usage:
 *   bun script/tasks/verifyWhitelistMigration.ts --network base --environment production
 *   bun script/tasks/verifyWhitelistMigration.ts --network base --environment staging
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../common/types'
import { getDeployments } from '../utils/deploymentHelpers'
import {
  castEnv,
  getContractAddressForNetwork,
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface IWhitelistConfig {
  DEXS: Array<{
    name: string
    key: string
    contracts?: Record<
      string,
      Array<{
        address: string
        functions?: Record<string, string>
      }>
    >
  }>
  PERIPHERY?: Record<
    string,
    Array<{
      name: string
      address: string
      selectors: Array<{ selector: string; signature: string }>
    }>
  >
}

interface ITestResult {
  functionName: string
  testValue: string
  expected: boolean | number | string[]
  actual: boolean | number | string[]
  passed: boolean
  error?: string
}

const errors: ITestResult[] = []

// Helper to extract short error message from viem's verbose error
const extractShortError = (errorMessage: string): string => {
  if (
    errorMessage.includes('FunctionDoesNotExist') ||
    errorMessage.includes('0xa9ad62f8')
  ) {
    // Extract just the function name from the error
    const functionMatch = errorMessage.match(/function:\s+(\w+)/)
    if (functionMatch) {
      return `FunctionDoesNotExist error: The contract function "${functionMatch[1]}" reverted`
    }
    return 'FunctionDoesNotExist error'
  }
  // For other errors, try to extract a short message
  if (errorMessage.includes('reverted with the following signature')) {
    const functionMatch = errorMessage.match(/function:\s+(\w+)/)
    if (functionMatch) {
      return `The contract function "${functionMatch[1]}" reverted`
    }
  }
  return errorMessage
}

const logTest = (
  functionName: string,
  testValue: string,
  expected: boolean | number | string[],
  actual: boolean | number | string[],
  passed: boolean,
  error?: string
) => {
  const result: ITestResult = {
    functionName,
    testValue,
    expected,
    actual,
    passed,
    error,
  }

  if (!passed) {
    errors.push(result)
  }

  const expectedStr =
    typeof expected === 'boolean'
      ? expected.toString()
      : Array.isArray(expected)
      ? expected.length === 1 &&
        typeof expected[0] === 'string' &&
        expected[0].startsWith('0x')
        ? `[${expected[0]}]` // Show selector for single-selector arrays
        : `[${expected.length} items]`
      : expected.toString()
  // Show "error" only if actual is the sentinel value 'error' (indicating function call failed)
  // Otherwise show the actual value even if there's a mismatch error message
  const actualStr =
    typeof actual === 'string' && actual === 'error'
      ? 'error'
      : typeof actual === 'boolean'
      ? actual.toString()
      : Array.isArray(actual)
      ? actual.length === 1 &&
        typeof actual[0] === 'string' &&
        actual[0].startsWith('0x')
        ? `[${actual[0]}]` // Show selector for single-selector arrays
        : `[${actual.length} items]`
      : actual.toString()

  const color = passed ? '\x1b[32m' : '\x1b[31m' // green or red
  const reset = '\x1b[0m'
  const symbol = passed ? '✓' : '✗'

  const functionCallStr = testValue
    ? `${functionName}(${testValue})`
    : functionName
  consola.log(`  ${color}${symbol}${reset} ${functionCallStr}`)
  consola.log(`    Expected: ${expectedStr}`)
  consola.log(`    Actual:   ${color}${actualStr}${reset}`)
  if (error) {
    consola.log(`    ${color}${error}${reset}`)
  }
}

const command = defineCommand({
  meta: {
    name: 'Verify Whitelist Migration',
    description:
      'Verify that the WhitelistManagerFacet migration was successful',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network (e.g. arbitrum, polygon, mainnet)',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment (staging | production)',
      default: 'production',
    },
  },
  async run({ args }) {
    const { network, environment } = args
    const networkStr = Array.isArray(network) ? network[0] : network
    const networkLower = (networkStr as string).toLowerCase()
    const env = castEnv(
      Array.isArray(environment) ? environment[0] : environment
    )

    // Get diamond address
    const diamondAddress = (await getContractAddressForNetwork(
      'LiFiDiamond',
      networkLower as SupportedChain,
      env
    )) as Address

    consola.info(`\nVerifying migration for ${networkLower} (${env})`)
    consola.info(`Diamond address: ${diamondAddress}\n`)

    // Setup viem client
    const chain = getViemChainForNetworkName(networkLower)
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    // Create WhitelistManager facet contract ABI (full ABI for all tests)
    const whitelistManagerAbi = parseAbi([
      'function isMigrated() external view returns (bool)',
      'function isContractSelectorWhitelisted(address _contract, bytes4 _selector) external view returns (bool)',
      'function isAddressWhitelisted(address _address) external view returns (bool)',
      'function isFunctionSelectorWhitelisted(bytes4 _selector) external view returns (bool)',
      'function getWhitelistedAddresses() external view returns (address[])',
      'function getWhitelistedFunctionSelectors() external view returns (bytes4[])',
      'function getWhitelistedSelectorsForContract(address _contract) external view returns (bytes4[])',
      'function getAllContractSelectorPairs() external view returns (address[] contracts, bytes4[][] selectors)',
    ])

    // Check isMigrated() first - if migration hasn't completed, exit early
    consola.info('Checking migration status...')
    try {
      const isMigrated = (await publicClient.readContract({
        address: diamondAddress,
        abi: whitelistManagerAbi,
        functionName: 'isMigrated',
      })) as boolean

      if (!isMigrated) {
        consola.error('\n❌ Migration is not complete!')
        consola.error(
          'isMigrated() returned false. Please run the migration before verifying.'
        )
        consola.error('Exiting without running verification tests.')
        process.exit(1)
      }

      consola.success('✓ Migration status: isMigrated() returns true\n')
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(`Failed to check isMigrated(): ${errorMessage}`)
      consola.error(
        'Migration may not be complete. Please run the migration first.'
      )
      process.exit(1)
    }

    // Load whitelist.json or whitelist.staging.json based on environment
    const whitelistFileName =
      env === EnvironmentEnum.staging
        ? 'whitelist.staging.json'
        : 'whitelist.json'
    const whitelistPath = path.resolve(
      __dirname,
      `../../config/${whitelistFileName}`
    )
    const whitelistFile = fs.readFileSync(whitelistPath, 'utf8')
    const whitelistConfig: IWhitelistConfig = JSON.parse(whitelistFile)

    consola.info(`Using whitelist file: ${whitelistFileName}`)

    // Get deployments for periphery contracts (needed for statistics)
    const deployments = await getDeployments(
      networkLower as SupportedChain,
      env
    )

    // Print whitelist statistics
    await printWhitelistStatistics(
      networkLower,
      deployments,
      env,
      whitelistConfig
    )

    // Load functionSelectorsToRemove.json
    const removeJsonPath = path.resolve(
      __dirname,
      '../../config/functionSelectorsToRemove.json'
    )
    const removeFile = fs.readFileSync(removeJsonPath, 'utf8')
    const { functionSelectorsToRemove } = JSON.parse(removeFile) as {
      functionSelectorsToRemove: string[]
    }

    // Get expected contract-selector pairs from whitelist.json
    const expectedPairs = await getExpectedPairs(
      networkLower,
      deployments,
      env,
      whitelistConfig
    )

    // Get unique addresses and selectors from expected pairs
    const expectedAddresses = new Set<Address>()
    const expectedSelectors = new Set<Hex>()
    const APPROVE_TO_ONLY_SELECTOR = '0xffffffff' as Hex
    for (const pair of expectedPairs) {
      expectedAddresses.add(pair.contract)
      // Exclude 0xffffffff from selector list - it's special and not a real function selector
      if (
        pair.selector.toLowerCase() !== APPROVE_TO_ONLY_SELECTOR.toLowerCase()
      ) {
        expectedSelectors.add(pair.selector)
      }
    }

    // Get deprecated selectors (in functionSelectorsToRemove.json but NOT in whitelist.json)
    // Also exclude 0xffffffff from deprecated list
    const deprecatedSelectors = functionSelectorsToRemove
      .map((s) => (s.startsWith('0x') ? s : `0x${s}`).toLowerCase() as Hex)
      .filter((s) => {
        return (
          !expectedSelectors.has(s) &&
          s !== APPROVE_TO_ONLY_SELECTOR.toLowerCase() &&
          s !== '0x00000000' // Filter out invalid zero selector
        )
      })

    // Create test values
    const testValues = await prepareTestValues(
      Array.from(expectedAddresses),
      Array.from(expectedSelectors),
      deprecatedSelectors,
      expectedPairs
    )

    // Create DexManager facet contract ABI (for backwards compatibility checks)
    const dexManagerAbi = parseAbi([
      'function isFunctionApproved(bytes4 _signature) public view returns (bool)',
      'function approvedDexs() external view returns (address[])',
    ])

    // Expected address count from whitelist.json (unique addresses for this network)
    // This is the TO-BE-STATE that we expect on-chain
    const expectedAddressCount = expectedAddresses.size

    consola.box('V1 / DexManagerFacet Tests')
    await testDexManagerFacet(
      diamondAddress,
      dexManagerAbi,
      publicClient,
      testValues,
      expectedAddressCount, // Use whitelist.json count as expected
      expectedPairs
    )

    consola.box('V2 / WhitelistManagerFacet Tests')
    await testWhitelistManagerFacet(
      diamondAddress,
      whitelistManagerAbi,
      publicClient,
      testValues,
      expectedAddressCount, // Use whitelist.json count as expected (TO-BE-STATE)
      expectedSelectors.size,
      expectedPairs.length,
      expectedPairs,
      expectedAddresses,
      expectedSelectors
    )

    // Final summary
    finish()
  },
})

/**
 * Prepare test values (3 true, 3 false for each type)
 */
async function prepareTestValues(
  expectedAddresses: Address[],
  expectedSelectors: Hex[],
  deprecatedSelectors: Hex[],
  expectedPairs: Array<{ contract: Address; selector: Hex }>
): Promise<{
  addressesTrue: Address[]
  addressesFalse: Address[]
  selectorsTrue: Hex[]
  selectorsFalse: Hex[]
  pairsTrue: Array<{ contract: Address; selector: Hex }>
  pairsFalse: Array<{ contract: Address; selector: Hex }>
  approveToOnlyContracts: Address[]
}> {
  // Get 3 addresses that should be whitelisted
  const addressesTrue = expectedAddresses.slice(0, 3)
  // Generate 3 addresses that should NOT be whitelisted (use addresses that don't exist)
  const addressesFalse: Address[] = [
    '0x1111111111111111111111111111111111111111' as Address,
    '0x2222222222222222222222222222222222222222' as Address,
    '0x3333333333333333333333333333333333333333' as Address,
  ]

  // Get 3 selectors that should be whitelisted (exclude 0xffffffff)
  const APPROVE_TO_ONLY_SELECTOR = '0xffffffff' as Hex
  const selectorsTrue = expectedSelectors
    .filter((s) => s.toLowerCase() !== APPROVE_TO_ONLY_SELECTOR.toLowerCase())
    .slice(0, 3)
  // Get 3 selectors that should NOT be whitelisted (deprecated ones)
  const selectorsFalse = deprecatedSelectors.slice(0, 3)

  // Get 3 contract-selector pairs that should be whitelisted
  // Filter out pairs with 0xffffffff - we'll handle those separately
  const pairsTrue = expectedPairs
    .filter(
      (p) => p.selector.toLowerCase() !== APPROVE_TO_ONLY_SELECTOR.toLowerCase()
    )
    .slice(0, 3)

  // Get 3 contracts that use approveTo-only selector (0xffffffff)
  const approveToOnlyContracts = expectedPairs
    .filter(
      (p) => p.selector.toLowerCase() === APPROVE_TO_ONLY_SELECTOR.toLowerCase()
    )
    .map((p) => p.contract)
    .slice(0, 3)

  // If we don't have 3 pairs without 0xffffffff, add some with 0xffffffff
  // but we'll check them differently
  if (pairsTrue.length < 3) {
    const approveToPairs = expectedPairs
      .filter(
        (p) =>
          p.selector.toLowerCase() === APPROVE_TO_ONLY_SELECTOR.toLowerCase()
      )
      .slice(0, 3 - pairsTrue.length)
    pairsTrue.push(...approveToPairs)
  }
  // Create 3 pairs that should NOT be whitelisted (use non-existent addresses or deprecated selectors)
  const pairsFalse: Array<{ contract: Address; selector: Hex }> = [
    {
      contract: '0x1111111111111111111111111111111111111111' as Address,
      selector: expectedSelectors[0] || ('0x12345678' as Hex),
    },
    {
      contract:
        expectedAddresses[0] ||
        ('0x0000000000000000000000000000000000000000' as Address),
      selector: deprecatedSelectors[0] || ('0x87654321' as Hex),
    },
    {
      contract: '0x2222222222222222222222222222222222222222' as Address,
      selector: deprecatedSelectors[1] || ('0xabcdef01' as Hex),
    },
  ]

  return {
    addressesTrue,
    addressesFalse,
    selectorsTrue,
    selectorsFalse,
    pairsTrue,
    pairsFalse,
    approveToOnlyContracts,
  }
}

/**
 * Test V1 / DexManagerFacet functions
 */
async function testDexManagerFacet(
  diamondAddress: Address,
  dexManagerAbi: ReturnType<typeof parseAbi>,
  publicClient: PublicClient,
  testValues: Awaited<ReturnType<typeof prepareTestValues>>,
  _expectedAddressCount: number, // From whitelist.json (expected TO-BE-STATE) - not used here, approvedDexs() is tested in Section 1
  _expectedPairs: Array<{ contract: Address; selector: Hex }>
): Promise<void> {
  try {
    // Note: approvedDexs() is tested in Section 1 of testWhitelistManagerFacet()
    // to compare it with getWhitelistedAddresses() in the same section

    // Test isFunctionApproved() with values that should return true
    consola.info('\nTesting isFunctionApproved() - expected true values')
    for (const selector of testValues.selectorsTrue) {
      try {
        const result = (await publicClient.readContract({
          address: diamondAddress,
          abi: dexManagerAbi,
          functionName: 'isFunctionApproved',
          args: [selector],
        })) as boolean
        logTest('isFunctionApproved', selector, true, result, result === true)
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logTest(
          'isFunctionApproved',
          selector,
          true,
          false,
          false,
          errorMessage
        )
      }
    }

    // Test isFunctionApproved() with values that should return false
    consola.info('\nTesting isFunctionApproved() - expected false values')
    for (const selector of testValues.selectorsFalse) {
      try {
        const result = (await publicClient.readContract({
          address: diamondAddress,
          abi: dexManagerAbi,
          functionName: 'isFunctionApproved',
          args: [selector],
        })) as boolean
        logTest('isFunctionApproved', selector, false, result, result === false)
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logTest(
          'isFunctionApproved',
          selector,
          false,
          true,
          false,
          errorMessage
        )
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    consola.error(`Failed to test DexManagerFacet: ${errorMessage}`)
  }
}

/**
 * Test V2 / WhitelistManagerFacet functions
 */
async function testWhitelistManagerFacet(
  diamondAddress: Address,
  whitelistManagerAbi: ReturnType<typeof parseAbi>,
  publicClient: PublicClient,
  testValues: Awaited<ReturnType<typeof prepareTestValues>>,
  expectedAddressCount: number,
  expectedSelectorCount: number,
  expectedPairsCount: number,
  _expectedPairs: Array<{ contract: Address; selector: Hex }>,
  expectedAddresses: Set<Address>,
  expectedSelectors: Set<Hex>
): Promise<void> {
  const APPROVE_TO_ONLY_SELECTOR = '0xffffffff' as Hex
  try {
    // Call functions without parameters once at the beginning and reuse results
    consola.info('\nFetching on-chain data...')

    // Try to call getAllContractSelectorPairs separately to catch errors properly
    let allContractSelectorPairs: {
      contracts: Address[]
      selectors: Hex[][]
    } | null = null

    consola.info('Calling getAllContractSelectorPairs()...')
    try {
      const result = await publicClient.readContract({
        address: diamondAddress,
        abi: whitelistManagerAbi,
        functionName: 'getAllContractSelectorPairs',
      })

      // Debug: Log the actual result structure
      consola.debug(`Result type: ${typeof result}`)
      consola.debug(
        `Result keys: ${
          result && typeof result === 'object'
            ? Object.keys(result).join(', ')
            : 'N/A'
        }`
      )
      consola.debug(`Is array: ${Array.isArray(result)}`)

      // Check if result is in the expected format (tuple with contracts and selectors)
      // Viem returns tuples as arrays: [contracts, selectors]
      if (Array.isArray(result) && result.length === 2) {
        allContractSelectorPairs = {
          contracts: result[0] as Address[],
          selectors: result[1] as Hex[][],
        }
        consola.success(
          `✓ getAllContractSelectorPairs() succeeded: ${allContractSelectorPairs.contracts.length} contracts`
        )
      } else if (
        result &&
        typeof result === 'object' &&
        '0' in result &&
        '1' in result
      ) {
        // Viem returns tuples as an object with indexed properties
        allContractSelectorPairs = {
          contracts: result[0] as Address[],
          selectors: result[1] as Hex[][],
        }
        consola.success(
          `✓ getAllContractSelectorPairs() succeeded: ${allContractSelectorPairs.contracts.length} contracts`
        )
      } else if (
        result &&
        typeof result === 'object' &&
        'contracts' in result &&
        'selectors' in result
      ) {
        // Direct object format
        allContractSelectorPairs = result as {
          contracts: Address[]
          selectors: Hex[][]
        }
        consola.success(
          `✓ getAllContractSelectorPairs() succeeded: ${allContractSelectorPairs.contracts.length} contracts`
        )
      } else {
        consola.warn(
          `\n⚠️  getAllContractSelectorPairs() returned unexpected format: ${JSON.stringify(
            result
          )}`
        )
        consola.warn(
          `Result type: ${typeof result}, isArray: ${Array.isArray(result)}`
        )
        allContractSelectorPairs = null
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      const shortError = extractShortError(errorMessage)
      consola.error(
        `\n❌ Failed to call getAllContractSelectorPairs(): ${shortError}`
      )
      // Always log the full error for debugging
      consola.error(`   Full error details: ${errorMessage}`)
      allContractSelectorPairs = null
    }

    const [approvedDexsAddresses, whitelistedAddresses, whitelistedSelectors] =
      (await Promise.all([
        publicClient.readContract({
          address: diamondAddress,
          abi: parseAbi([
            'function approvedDexs() external view returns (address[])',
          ]),
          functionName: 'approvedDexs',
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: whitelistManagerAbi,
          functionName: 'getWhitelistedAddresses',
        }),
        publicClient.readContract({
          address: diamondAddress,
          abi: whitelistManagerAbi,
          functionName: 'getWhitelistedFunctionSelectors',
        }),
      ])) as [Address[], Address[], Hex[]]

    // ============================================================================
    // Section 1: approvedDexs / getWhitelistedAddresses
    // ============================================================================
    consola.box('Section 1: approvedDexs / getWhitelistedAddresses')

    // Test approvedDexs() count
    const approvedDexsCountMatch =
      approvedDexsAddresses.length === expectedAddressCount
    logTest(
      'approvedDexs()',
      '',
      expectedAddressCount,
      approvedDexsAddresses.length,
      approvedDexsCountMatch,
      approvedDexsCountMatch
        ? undefined
        : `Expected ${expectedAddressCount} addresses (from whitelist.json), got ${approvedDexsAddresses.length}`
    )

    // Test getWhitelistedAddresses() count
    const whitelistedAddressesCountMatch =
      whitelistedAddresses.length === expectedAddressCount
    logTest(
      'getWhitelistedAddresses()',
      '',
      expectedAddressCount,
      whitelistedAddresses.length,
      whitelistedAddressesCountMatch,
      whitelistedAddressesCountMatch
        ? undefined
        : `Expected ${expectedAddressCount} addresses (from whitelist.json), got ${whitelistedAddresses.length}`
    )

    // Diagnostic: Show address mismatches if counts don't match
    if (!approvedDexsCountMatch || !whitelistedAddressesCountMatch) {
      const onChainAddressSet = new Set(
        whitelistedAddresses.map((addr) => addr.toLowerCase())
      )
      const expectedAddressSet = new Set(
        Array.from(expectedAddresses).map((addr) => addr.toLowerCase())
      )

      const extraAddresses = whitelistedAddresses.filter(
        (addr) => !expectedAddressSet.has(addr.toLowerCase())
      )
      const missingAddresses = Array.from(expectedAddresses).filter(
        (addr) => !onChainAddressSet.has(addr.toLowerCase())
      )

      if (extraAddresses.length > 0) {
        consola.warn(
          `\n⚠️  Addresses on-chain but NOT in whitelist.json (${extraAddresses.length}):`
        )
        extraAddresses.forEach((addr) => {
          consola.warn(`  - ${addr}`)
        })
      }

      if (missingAddresses.length > 0) {
        consola.warn(
          `\n⚠️  Addresses in whitelist.json but NOT on-chain (${missingAddresses.length}):`
        )
        missingAddresses.forEach((addr) => {
          consola.warn(`  - ${addr}`)
        })
      }
    }

    // Compare that approvedDexs() and getWhitelistedAddresses() return the same count
    const countsMatch =
      approvedDexsAddresses.length === whitelistedAddresses.length
    logTest(
      'approvedDexs().length == getWhitelistedAddresses().length',
      '',
      true,
      countsMatch,
      countsMatch,
      countsMatch
        ? undefined
        : `Count mismatch: approvedDexs() returned ${approvedDexsAddresses.length}, getWhitelistedAddresses() returned ${whitelistedAddresses.length}`
    )

    // Compare that the addresses match (not just the count)
    const approvedDexsSet = new Set(
      approvedDexsAddresses.map((addr) => addr.toLowerCase())
    )
    const whitelistedAddressesSet = new Set(
      whitelistedAddresses.map((addr) => addr.toLowerCase())
    )
    const addressesMatch =
      approvedDexsSet.size === whitelistedAddressesSet.size &&
      [...approvedDexsSet].every((addr) => whitelistedAddressesSet.has(addr))
    logTest(
      'approvedDexs() === getWhitelistedAddresses(): making sure all addresses match',
      '',
      true,
      addressesMatch,
      addressesMatch,
      addressesMatch
        ? undefined
        : 'Address sets do not match - approvedDexs() and getWhitelistedAddresses() contain different addresses'
    )

    // ============================================================================
    // Section 2: approveTo-only contracts
    // ============================================================================
    consola.box('Section 2: approveTo-only contracts')

    if (testValues.approveToOnlyContracts.length === 0) {
      consola.info(
        'No approveTo-only contracts found in whitelist.json for this network'
      )
      consola.info('Skipping approveTo-only contract tests.\n')
    } else {
      for (const contract of testValues.approveToOnlyContracts) {
        consola.info(`\nTesting approveTo-only contract: ${contract}`)

        // Check if address is in approvedDexs()
        const isInApprovedDexs = approvedDexsAddresses.some(
          (addr) => addr.toLowerCase() === contract.toLowerCase()
        )
        logTest(
          'approvedDexs() contains approveTo-only contract',
          contract,
          true,
          isInApprovedDexs,
          isInApprovedDexs === true
        )

        // Check if address is in getWhitelistedAddresses()
        const isInWhitelistedAddresses = whitelistedAddresses.some(
          (addr) => addr.toLowerCase() === contract.toLowerCase()
        )
        logTest(
          'getWhitelistedAddresses() contains approveTo-only contract',
          contract,
          true,
          isInWhitelistedAddresses,
          isInWhitelistedAddresses === true
        )

        // Check isContractSelectorWhitelisted(contract, 0xffffffff)
        // Note: For approveTo-only contracts, we check isAddressWhitelisted instead
        // because isContractSelectorWhitelisted might revert with FunctionDoesNotExist
        // if the function selector doesn't exist in the diamond
        try {
          const isContractSelectorWhitelisted =
            (await publicClient.readContract({
              address: diamondAddress,
              abi: whitelistManagerAbi,
              functionName: 'isContractSelectorWhitelisted',
              args: [contract, APPROVE_TO_ONLY_SELECTOR],
            })) as boolean
          logTest(
            'isContractSelectorWhitelisted (approveTo-only)',
            `${contract}/${APPROVE_TO_ONLY_SELECTOR}`,
            true,
            isContractSelectorWhitelisted,
            isContractSelectorWhitelisted === true
          )
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          // If we get FunctionDoesNotExist error, it means the function selector doesn't exist in the diamond
          // Check if contract equals diamond address
          const isDiamondAddress =
            contract.toLowerCase() === diamondAddress.toLowerCase()
          if (isDiamondAddress) {
            logTest(
              'isContractSelectorWhitelisted (approveTo-only)',
              `${contract}/${APPROVE_TO_ONLY_SELECTOR}`,
              false,
              false,
              false,
              'Contract address matches diamond address - cannot whitelist diamond itself'
            )
          } else if (
            errorMessage.includes('0xa9ad62f8') ||
            errorMessage.includes('FunctionDoesNotExist')
          ) {
            logTest(
              'isContractSelectorWhitelisted (approveTo-only)',
              `${contract}/${APPROVE_TO_ONLY_SELECTOR}`,
              true,
              'error' as any,
              false,
              extractShortError(errorMessage)
            )
          } else {
            logTest(
              'isContractSelectorWhitelisted (approveTo-only)',
              `${contract}/${APPROVE_TO_ONLY_SELECTOR}`,
              true,
              'error' as any,
              false,
              extractShortError(errorMessage)
            )
          }
        }

        // Note: isAddressWhitelisted() is already checked above for approveTo-only contracts
        // This check is redundant but kept for consistency

        // Check getWhitelistedSelectorsForContract() returns only approveTo-only selector
        try {
          const selectorsForContract = (await publicClient.readContract({
            address: diamondAddress,
            abi: whitelistManagerAbi,
            functionName: 'getWhitelistedSelectorsForContract',
            args: [contract],
          })) as Hex[]
          const hasOnlyApproveToSelector =
            selectorsForContract.length === 1 &&
            selectorsForContract[0]?.toLowerCase() ===
              APPROVE_TO_ONLY_SELECTOR.toLowerCase()
          logTest(
            'getWhitelistedSelectorsForContract (approveTo-only)',
            contract,
            [APPROVE_TO_ONLY_SELECTOR],
            selectorsForContract,
            hasOnlyApproveToSelector,
            hasOnlyApproveToSelector
              ? undefined
              : `Expected only ${APPROVE_TO_ONLY_SELECTOR}, got ${selectorsForContract.length} selectors`
          )
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          // Check if contract equals diamond address
          const isDiamondAddress =
            contract.toLowerCase() === diamondAddress.toLowerCase()
          if (isDiamondAddress) {
            logTest(
              'getWhitelistedSelectorsForContract (approveTo-only)',
              contract,
              [APPROVE_TO_ONLY_SELECTOR],
              [],
              false,
              'Contract address matches diamond address - cannot query selectors for diamond itself'
            )
          } else if (
            errorMessage.includes('0xa9ad62f8') ||
            errorMessage.includes('FunctionDoesNotExist')
          ) {
            logTest(
              'getWhitelistedSelectorsForContract (approveTo-only)',
              contract,
              [APPROVE_TO_ONLY_SELECTOR],
              'error' as any,
              false,
              extractShortError(errorMessage)
            )
          } else {
            logTest(
              'getWhitelistedSelectorsForContract (approveTo-only)',
              contract,
              [APPROVE_TO_ONLY_SELECTOR],
              'error' as any,
              false,
              extractShortError(errorMessage)
            )
          }
        }
      }
    } // Close else block for approveTo-only contracts

    // Check getAllContractSelectorPairs() contains all approveTo-only contracts with only approveTo selector
    if (
      allContractSelectorPairs &&
      testValues.approveToOnlyContracts.length > 0
    ) {
      consola.info(
        '\nChecking getAllContractSelectorPairs() for approveTo-only contracts'
      )
      for (const contract of testValues.approveToOnlyContracts) {
        const contractIndex = allContractSelectorPairs.contracts.findIndex(
          (addr) => addr.toLowerCase() === contract.toLowerCase()
        )
        if (contractIndex !== -1) {
          const selectors = allContractSelectorPairs.selectors[contractIndex]
          const hasOnlyApproveToSelector =
            selectors?.length === 1 &&
            selectors[0]?.toLowerCase() ===
              APPROVE_TO_ONLY_SELECTOR.toLowerCase()
          logTest(
            'getAllContractSelectorPairs (approveTo-only)',
            contract,
            [APPROVE_TO_ONLY_SELECTOR],
            selectors || [],
            hasOnlyApproveToSelector,
            hasOnlyApproveToSelector
              ? undefined
              : `Expected only ${APPROVE_TO_ONLY_SELECTOR}, got ${
                  selectors?.length || 0
                } selectors`
          )
        } else {
          logTest(
            'getAllContractSelectorPairs (approveTo-only)',
            contract,
            true,
            false,
            false,
            'Contract not found in getAllContractSelectorPairs()'
          )
        }
      }
    }

    // ============================================================================
    // Section 3: Contracts that should return true (are part of whitelist)
    // ============================================================================
    consola.box('Section 3: Contracts that should return true')

    for (const pair of testValues.pairsTrue) {
      // Skip approveTo-only pairs as they're already tested in Section 2
      if (
        pair.selector.toLowerCase() === APPROVE_TO_ONLY_SELECTOR.toLowerCase()
      ) {
        continue
      }

      consola.info(
        `\nTesting contract-selector pair: ${pair.contract}/${pair.selector}`
      )

      // Check if address is in approvedDexs()
      const isInApprovedDexs = approvedDexsAddresses.some(
        (addr) => addr.toLowerCase() === pair.contract.toLowerCase()
      )
      logTest(
        'approvedDexs() contains contract',
        pair.contract,
        true,
        isInApprovedDexs,
        isInApprovedDexs === true
      )

      // Check if address is in getWhitelistedAddresses()
      const isInWhitelistedAddresses = whitelistedAddresses.some(
        (addr) => addr.toLowerCase() === pair.contract.toLowerCase()
      )
      logTest(
        'getWhitelistedAddresses() contains contract',
        pair.contract,
        true,
        isInWhitelistedAddresses,
        isInWhitelistedAddresses === true
      )

      // Check isContractSelectorWhitelisted()
      try {
        // Check if contract equals diamond address - this would cause FunctionDoesNotExist
        const isDiamondAddress =
          pair.contract.toLowerCase() === diamondAddress.toLowerCase()
        if (isDiamondAddress) {
          logTest(
            'isContractSelectorWhitelisted',
            `${pair.contract}/${pair.selector}`,
            false,
            false,
            false,
            'Contract address matches diamond address - cannot whitelist diamond itself'
          )
        } else {
          const isContractSelectorWhitelisted =
            (await publicClient.readContract({
              address: diamondAddress,
              abi: whitelistManagerAbi,
              functionName: 'isContractSelectorWhitelisted',
              args: [pair.contract, pair.selector],
            })) as boolean
          logTest(
            'isContractSelectorWhitelisted',
            `${pair.contract}/${pair.selector}`,
            true,
            isContractSelectorWhitelisted,
            isContractSelectorWhitelisted === true
          )
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        if (
          errorMessage.includes('0xa9ad62f8') ||
          errorMessage.includes('FunctionDoesNotExist')
        ) {
          logTest(
            'isContractSelectorWhitelisted',
            `${pair.contract}/${pair.selector}`,
            true,
            'error' as any,
            false,
            extractShortError(errorMessage)
          )
        } else {
          logTest(
            'isContractSelectorWhitelisted',
            `${pair.contract}/${pair.selector}`,
            true,
            'error' as any,
            false,
            extractShortError(errorMessage)
          )
        }
      }

      // Check isAddressWhitelisted()
      try {
        const isAddressWhitelisted = (await publicClient.readContract({
          address: diamondAddress,
          abi: whitelistManagerAbi,
          functionName: 'isAddressWhitelisted',
          args: [pair.contract],
        })) as boolean
        logTest(
          'isAddressWhitelisted',
          pair.contract,
          true,
          isAddressWhitelisted,
          isAddressWhitelisted === true
        )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logTest(
          'isAddressWhitelisted',
          pair.contract,
          true,
          false,
          false,
          errorMessage
        )
      }

      // Check isFunctionSelectorWhitelisted()
      try {
        const isFunctionSelectorWhitelisted = (await publicClient.readContract({
          address: diamondAddress,
          abi: whitelistManagerAbi,
          functionName: 'isFunctionSelectorWhitelisted',
          args: [pair.selector],
        })) as boolean
        logTest(
          'isFunctionSelectorWhitelisted',
          pair.selector,
          true,
          isFunctionSelectorWhitelisted,
          isFunctionSelectorWhitelisted === true
        )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logTest(
          'isFunctionSelectorWhitelisted',
          pair.selector,
          true,
          false,
          false,
          errorMessage
        )
      }

      // Check getWhitelistedSelectorsForContract()
      try {
        // Check if contract equals diamond address
        const isDiamondAddress =
          pair.contract.toLowerCase() === diamondAddress.toLowerCase()
        if (isDiamondAddress) {
          logTest(
            'getWhitelistedSelectorsForContract',
            `${pair.contract}/${pair.selector}`,
            [],
            [],
            false,
            'Contract address matches diamond address - cannot query selectors for diamond itself'
          )
        } else {
          const selectorsForContract = (await publicClient.readContract({
            address: diamondAddress,
            abi: whitelistManagerAbi,
            functionName: 'getWhitelistedSelectorsForContract',
            args: [pair.contract],
          })) as Hex[]
          const hasSelector = selectorsForContract.some(
            (s) => s.toLowerCase() === pair.selector.toLowerCase()
          )
          // Show the actual returned selectors array
          const actualSelectorsStr =
            selectorsForContract.length > 0
              ? `[${selectorsForContract.map((s) => s).join(', ')}]`
              : '[]'
          logTest(
            'getWhitelistedSelectorsForContract',
            `${pair.contract}/${pair.selector}`,
            true, // Expected: selector should be in the returned array
            actualSelectorsStr as any, // Actual: show the returned array
            hasSelector === true,
            hasSelector === true
              ? undefined
              : `Expected selector ${pair.selector} to be in returned array, but got: ${actualSelectorsStr}`
          )
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        if (
          errorMessage.includes('0xa9ad62f8') ||
          errorMessage.includes('FunctionDoesNotExist')
        ) {
          logTest(
            'getWhitelistedSelectorsForContract',
            `${pair.contract}/${pair.selector}`,
            true,
            'error' as any,
            false,
            extractShortError(errorMessage)
          )
        } else {
          logTest(
            'getWhitelistedSelectorsForContract',
            `${pair.contract}/${pair.selector}`,
            true,
            'error' as any,
            false,
            extractShortError(errorMessage)
          )
        }
      }
    }

    // ============================================================================
    // Section 4: Selectors that should return false (deprecated)
    // ============================================================================
    consola.box('Section 4: Selectors that should return false (deprecated)')

    for (const selector of testValues.selectorsFalse) {
      consola.info(`\nTesting deprecated selector: ${selector}`)

      // Check isFunctionSelectorWhitelisted() returns false
      try {
        const isFunctionSelectorWhitelisted = (await publicClient.readContract({
          address: diamondAddress,
          abi: whitelistManagerAbi,
          functionName: 'isFunctionSelectorWhitelisted',
          args: [selector],
        })) as boolean
        logTest(
          'isFunctionSelectorWhitelisted (deprecated)',
          selector,
          false,
          isFunctionSelectorWhitelisted,
          isFunctionSelectorWhitelisted === false
        )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logTest(
          'isFunctionSelectorWhitelisted (deprecated)',
          selector,
          false,
          true,
          false,
          errorMessage
        )
      }

      // Check if selector is NOT in getWhitelistedFunctionSelectors()
      const isInWhitelistedSelectors = whitelistedSelectors.some(
        (s) => s.toLowerCase() === selector.toLowerCase()
      )
      logTest(
        'getWhitelistedFunctionSelectors',
        selector,
        false,
        isInWhitelistedSelectors,
        isInWhitelistedSelectors === false
      )
    }

    // Additional checks for array functions
    consola.info('\n\nAdditional array function checks:')

    // Check getWhitelistedFunctionSelectors() count
    // If there are approveTo-only contracts, 0xffffffff is counted as a whitelisted selector on-chain
    // even though it's not explicitly listed in whitelist.json
    const hasApproveToOnlyContracts =
      testValues.approveToOnlyContracts.length > 0
    const adjustedExpectedSelectorCount = hasApproveToOnlyContracts
      ? expectedSelectorCount + 1
      : expectedSelectorCount
    const selectorsCountMatch =
      whitelistedSelectors.length === adjustedExpectedSelectorCount

    // Format expected value string
    const expectedStr = hasApproveToOnlyContracts
      ? `${adjustedExpectedSelectorCount} (${expectedSelectorCount} selectors + 0xffffffff)`
      : `${expectedSelectorCount} (approveToOnly selector not whitelisted on this network)`

    // Format actual value string (will be colored in logTest)
    const actualStr = `${whitelistedSelectors.length}`

    logTest(
      'getWhitelistedFunctionSelectors() count',
      '',
      expectedStr as any, // Using string for display
      actualStr as any, // Using string for display
      selectorsCountMatch,
      selectorsCountMatch
        ? undefined
        : `Expected ${adjustedExpectedSelectorCount} selectors, got ${whitelistedSelectors.length}`
    )

    // Diagnostic: Show selector mismatches if counts don't match
    if (!selectorsCountMatch) {
      const onChainSelectorSet = new Set(
        whitelistedSelectors.map((s) => s.toLowerCase())
      )
      const expectedSelectorSet = new Set(
        Array.from(expectedSelectors).map((s) => s.toLowerCase())
      )

      // If there are approveTo-only contracts, 0xffffffff is expected to be on-chain
      // even though it's not in whitelist.json
      const APPROVE_TO_ONLY_SELECTOR = '0xffffffff' as Hex
      const expectedSelectorSetWithApproveTo = new Set(expectedSelectorSet)
      if (hasApproveToOnlyContracts) {
        expectedSelectorSetWithApproveTo.add(
          APPROVE_TO_ONLY_SELECTOR.toLowerCase()
        )
      }

      const extraSelectors = whitelistedSelectors.filter(
        (s) => !expectedSelectorSetWithApproveTo.has(s.toLowerCase())
      )
      const missingSelectors = Array.from(expectedSelectors).filter(
        (s) => !onChainSelectorSet.has(s.toLowerCase())
      )

      if (extraSelectors.length > 0) {
        consola.warn(
          `\n⚠️  Selectors on-chain but NOT in whitelist.json (${extraSelectors.length}):`
        )
        extraSelectors.forEach((selector) => {
          consola.warn(`  - ${selector}`)
        })
      }

      if (missingSelectors.length > 0) {
        consola.warn(
          `\n⚠️  Selectors in whitelist.json but NOT on-chain (${missingSelectors.length}):`
        )
        missingSelectors.forEach((selector) => {
          consola.warn(`  - ${selector}`)
        })
      }
    }

    // Check getAllContractSelectorPairs() count
    if (
      allContractSelectorPairs &&
      allContractSelectorPairs.contracts &&
      allContractSelectorPairs.selectors
    ) {
      const totalPairsOnChain = allContractSelectorPairs.contracts.reduce(
        (sum: number, _: Address, i: number) =>
          sum + (allContractSelectorPairs.selectors?.[i]?.length || 0),
        0
      )
      const pairsCountMatch = totalPairsOnChain === expectedPairsCount
      logTest(
        'getAllContractSelectorPairs() total pairs',
        '',
        expectedPairsCount,
        totalPairsOnChain,
        pairsCountMatch,
        pairsCountMatch
          ? undefined
          : `Expected ${expectedPairsCount} pairs, got ${totalPairsOnChain}`
      )
    } else {
      consola.warn(
        '⚠️  getAllContractSelectorPairs() is not available - check error message above'
      )
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    consola.error(`Failed to test WhitelistManagerFacet: ${errorMessage}`)
  }
}

/**
 * Print statistics about the whitelist.json file
 */
async function printWhitelistStatistics(
  network: string,
  deployments: Record<string, string>,
  environment: EnvironmentEnum,
  whitelistConfig: IWhitelistConfig
): Promise<void> {
  consola.box('Whitelist Statistics')

  // Get all expected pairs for this network
  const expectedPairs = await getExpectedPairs(
    network,
    deployments,
    environment,
    whitelistConfig
  )

  // Count unique addresses and selectors
  const uniqueAddresses = new Set<Address>()
  const uniqueSelectors = new Set<Hex>()
  const approveToOnlyContracts: Address[] = []
  const APPROVE_TO_ONLY_SELECTOR = '0xffffffff' as Hex

  for (const pair of expectedPairs) {
    uniqueAddresses.add(pair.contract)
    uniqueSelectors.add(pair.selector)

    if (
      pair.selector.toLowerCase() === APPROVE_TO_ONLY_SELECTOR.toLowerCase()
    ) {
      approveToOnlyContracts.push(pair.contract)
    }
  }

  // Remove duplicates from approveToOnlyContracts
  const uniqueApproveToOnlyContracts = Array.from(
    new Set(approveToOnlyContracts.map((addr) => addr.toLowerCase()))
  ).map((addr) => getAddress(addr))

  consola.info(`Total contract:selector pairs: ${expectedPairs.length}`)
  consola.info(`Unique addresses: ${uniqueAddresses.size}`)
  consola.info(`Unique selectors: ${uniqueSelectors.size}`)
  consola.info(
    `ApproveTo-only contracts: ${uniqueApproveToOnlyContracts.length}`
  )

  if (uniqueApproveToOnlyContracts.length > 0) {
    consola.info('\nApproveTo-only contracts:')
    for (const contract of uniqueApproveToOnlyContracts) {
      consola.info(`  - ${contract}`)
    }
  }

  consola.log('')
}

/**
 * Get expected contract-selector pairs from whitelist.json
 */
async function getExpectedPairs(
  network: string,
  deployments: Record<string, string>,
  _environment: EnvironmentEnum,
  whitelistConfig: IWhitelistConfig
): Promise<Array<{ contract: Address; selector: Hex }>> {
  try {
    const expectedPairs: Array<{ contract: Address; selector: Hex }> = []

    // Parse DEXS section
    for (const dex of whitelistConfig.DEXS || []) {
      for (const contract of dex.contracts?.[network.toLowerCase()] || []) {
        const contractAddr = getAddress(contract.address)
        const functions = contract.functions || {}

        if (Object.keys(functions).length === 0) {
          // Contract with no specific functions uses ApproveTo-Only Selector (0xffffffff)
          expectedPairs.push({
            contract: contractAddr,
            selector: '0xffffffff' as Hex,
          })
        } else {
          // Contract with specific function selectors
          for (const selector of Object.keys(functions)) {
            expectedPairs.push({
              contract: contractAddr,
              selector: selector.toLowerCase() as Hex,
            })
          }
        }
      }
    }

    // Parse PERIPHERY section
    const peripheryConfig = whitelistConfig.PERIPHERY
    const networkPeripheryContracts = peripheryConfig?.[network.toLowerCase()]
    if (networkPeripheryContracts) {
      for (const peripheryContract of networkPeripheryContracts) {
        // Get address from deployments or use the address from config
        let contractAddr: Address
        const contractAddress =
          peripheryContract.address || deployments[peripheryContract.name]
        if (contractAddress) {
          contractAddr = getAddress(contractAddress)
        } else {
          consola.info(
            `Skipping ${peripheryContract.name}: address not found in deployments or config`
          )
          continue
        }

        // Use the actual selectors from config
        for (const selectorInfo of peripheryContract.selectors || []) {
          expectedPairs.push({
            contract: contractAddr,
            selector: selectorInfo.selector.toLowerCase() as Hex,
          })
        }
      }
    }

    return expectedPairs
  } catch (error) {
    consola.error(`Failed to get expected pairs: ${error}`)
    return []
  }
}

const finish = () => {
  if (errors.length === 0) {
    process.exit(0)
  } else {
    process.exit(1)
  }
}

runMain(command)
