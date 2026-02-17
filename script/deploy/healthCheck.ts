// @ts-nocheck
import { execSync } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  createPublicClient,
  formatEther,
  getAddress,
  getContract,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import {
  coreFacets,
  corePeriphery,
  pauserWallet,
  whitelistPeripheryFunctions,
} from '../../config/global.json'
import { DEV_WALLET_ADDRESS } from '../demoScripts/utils/demoScriptHelpers'
import { initTronWeb } from '../troncast/utils/tronweb'
import {
  getViemChainForNetworkName,
  networks,
  type Network,
} from '../utils/viemScriptHelpers'

import targetState from './_targetState.json'
import {
  checkIsDeployedTron,
  getCoreFacets as getTronCoreFacets,
  getTronCorePeriphery,
  parseTroncastFacetsOutput,
} from './tron/utils'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SAFE_THRESHOLD = 3

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

const errors: string[] = []
const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Health Check',
    description: 'Check that the diamond is configured correctly',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment to check (production or staging)',
      default: 'production',
    },
  },
  async run({ args }) {
    const { network, environment } = args
    const networkStr = Array.isArray(network) ? network[0] : network
    const networkLower = (networkStr as string).toLowerCase()

    // Skip tronshasta testnet but allow tron mainnet
    if (networkLower === 'tronshasta') {
      consola.info('Health checks are not implemented for Tron Shasta testnet.')
      consola.info('Skipping all tests.')
      process.exit(0)
    }

    // Determine if we're working with Tron mainnet
    const isTron = networkLower === 'tron'

    const { default: deployedContracts } = await import(
      `../../deployments/${networkLower}${
        environment === 'staging' ? '.staging' : ''
      }.json`
    )
    const targetStateJson = await import(`./_targetState.json`)

    // Get core facets - use Tron-specific filtering if needed
    let coreFacetsToCheck: string[]
    if (isTron)
      // Use the Tron-specific utility that filters out GasZipFacet
      coreFacetsToCheck = getTronCoreFacets()
    else coreFacetsToCheck = coreFacets

    // For staging, skip targetState checks as targetState is only for production
    let nonCoreFacets: string[] = []
    if (environment === 'production') {
      nonCoreFacets = Object.keys(
        targetStateJson[networkLower]['production'].LiFiDiamond
      ).filter((k) => {
        return (
          !coreFacetsToCheck.includes(k) &&
          !corePeriphery.includes(k) &&
          k !== 'LiFiDiamond' &&
          k.includes('Facet')
        )
      })
    }

    const globalConfig = await import('../../config/global.json')
    const networksConfig = await import('../../config/networks.json')

    let publicClient: PublicClient | undefined
    let tronWeb: TronWeb | undefined

    if (isTron)
      tronWeb = initTronWeb(
        'mainnet',
        undefined,
        networksConfig[networkLower].rpcUrl
      )
    else {
      const chain = getViemChainForNetworkName(networkLower)
      publicClient = createPublicClient({
        batch: { multicall: true },
        chain,
        transport: http(),
      })
    }

    consola.info('Running post deployment checks...\n')

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check Diamond Contract                   │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking diamond Contract...')
    let diamondDeployed: boolean
    if (isTron && tronWeb)
      diamondDeployed = await checkIsDeployedTron(
        'LiFiDiamond',
        deployedContracts,
        tronWeb
      )
    else if (publicClient)
      diamondDeployed = await checkIsDeployed(
        'LiFiDiamond',
        deployedContracts,
        publicClient
      )
    else diamondDeployed = false

    if (!diamondDeployed) {
      logError(`LiFiDiamond not deployed`)
      finish()
    } else consola.success('LiFiDiamond deployed')

    const diamondAddress = deployedContracts['LiFiDiamond']

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                    Check core facets                    │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking Core Facets...')
    for (const facet of coreFacetsToCheck) {
      let isDeployed: boolean
      if (isTron && tronWeb)
        isDeployed = await checkIsDeployedTron(
          facet,
          deployedContracts,
          tronWeb
        )
      else if (publicClient)
        isDeployed = await checkIsDeployed(
          facet,
          deployedContracts,
          publicClient
        )
      else isDeployed = false

      if (!isDeployed) {
        logError(`Facet ${facet} not deployed`)
        continue
      }
      consola.success(`Facet ${facet} deployed`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │         Check that non core facets are deployed         │
    //          ╰─────────────────────────────────────────────────────────────╯
    if (environment === 'production') {
      consola.box('Checking Non-Core facets...')
      for (const facet of nonCoreFacets) {
        let isDeployed: boolean
        if (isTron && tronWeb)
          isDeployed = await checkIsDeployedTron(
            facet,
            deployedContracts,
            tronWeb
          )
        else if (publicClient)
          isDeployed = await checkIsDeployed(
            facet,
            deployedContracts,
            publicClient
          )
        else isDeployed = false

        if (!isDeployed) {
          logError(`Facet ${facet} not deployed`)
          continue
        }
        consola.success(`Facet ${facet} deployed`)
      }
    } else {
      consola.info('Skipping non-core facet checks for staging environment')
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │          Check that all facets are registered           │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking facets registered in diamond...')

    let registeredFacets: string[] = []
    try {
      if (isTron) {
        // Use troncast for Tron
        // Diamond address in deployments is already in Tron format
        const rpcUrl = networksConfig[networkLower].rpcUrl
        const rawString = execSync(
          `bun troncast call "${diamondAddress}" "facets() returns ((address,bytes4[])[])" --rpc-url "${rpcUrl}"`,
          { encoding: 'utf8' }
        )

        // Parse Tron output format
        const onChainFacets = parseTroncastFacetsOutput(rawString)

        if (Array.isArray(onChainFacets)) {
          // Map Tron addresses directly (deployments already use Tron format)
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]) => {
              // Address is already in Tron format for Tron deployments
              return [address.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets
            .map(([tronAddress]) => {
              return configFacetsByAddress[tronAddress.toLowerCase()]
            })
            .filter(Boolean)
        }
      } else if (networksConfig[networkLower].rpcUrl && publicClient) {
        // Existing EVM logic
        const rpcUrl: string = publicClient.chain.rpcUrls.default.http[0]
        const rawString = execSync(
          `cast call "${diamondAddress}" "facets() returns ((address,bytes4[])[])" --rpc-url "${rpcUrl}"`,
          { encoding: 'utf8' }
        )

        const jsonCompatibleString = rawString
          .replace(/\(/g, '[')
          .replace(/\)/g, ']')
          .replace(/0x[0-9a-fA-F]+/g, '"$&"')

        const onChainFacets = JSON.parse(jsonCompatibleString)

        if (Array.isArray(onChainFacets)) {
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]) => {
              return [address.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets.map(([address]) => {
            return configFacetsByAddress[address.toLowerCase()]
          })
        }
      }
    } catch (error) {
      consola.warn('Unable to parse output - skipping facet registration check')
      consola.warn('Error:', error)
    }

    for (const facet of [...coreFacetsToCheck, ...nonCoreFacets])
      if (!registeredFacets.includes(facet))
        logError(
          `Facet ${facet} not registered in Diamond or possibly unverified`
        )
      else consola.success(`Facet ${facet} registered in Diamond`)

    //          ╭─────────────────────────────────────────────────────────╮
    //          │      Check that core periphery contracts are deployed   │
    //          ╰─────────────────────────────────────────────────────────╯
    if (environment === 'production') {
      consola.box('Checking deploy status of periphery contracts...')

      // Filter periphery contracts for Tron if needed
      const peripheryToCheck = isTron ? getTronCorePeriphery() : corePeriphery

      for (const contract of peripheryToCheck) {
        let isDeployed: boolean
        if (isTron && tronWeb)
          isDeployed = await checkIsDeployedTron(
            contract,
            deployedContracts,
            tronWeb
          )
        else if (publicClient)
          isDeployed = await checkIsDeployed(
            contract,
            deployedContracts,
            publicClient
          )
        else isDeployed = false

        if (!isDeployed) {
          logError(`Periphery contract ${contract} not deployed`)
          continue
        }
        consola.success(`Periphery contract ${contract} deployed`)
      }
    } else {
      consola.info(
        'Skipping core periphery deployment checks for staging environment'
      )
    }

    // Skip remaining checks for Tron as they require specific implementations
    if (isTron) {
      consola.info(
        '\nNote: Advanced checks (DEXs, permissions, SAFE) are not yet implemented for Tron'
      )
      finish()
      return
    }

    const deployerWallet = getAddress(
      environment === 'staging'
        ? DEV_WALLET_ADDRESS
        : globalConfig.deployerWallet
    )

    // Load whitelist config (staging or production)
    const whitelistConfig = await import(
      `../../config/whitelist${
        environment === 'staging' ? '.staging' : ''
      }.json`
    )

    // Check Executor authorization in ERC20Proxy
    const erc20Proxy = getContract({
      address: deployedContracts['ERC20Proxy'],
      abi: parseAbi([
        'function authorizedCallers(address) external view returns (bool)',
        'function owner() external view returns (address)',
      ]),
      client: publicClient,
    })

    if (environment === 'production') {
      const executorAddress = deployedContracts['Executor']
      const isExecutorAuthorized = await erc20Proxy.read.authorizedCallers([
        executorAddress,
      ])

      if (!isExecutorAuthorized)
        logError('Executor is not authorized in ERC20Proxy')
      else consola.success('Executor is authorized in ERC20Proxy')
    } else {
      consola.info(
        'Skipping Executor authorization check for staging environment because Executor is not deployed'
      )
    }
    //          ╭─────────────────────────────────────────────────────────╮
    //          │          Check registered periphery contracts           │
    //          ╰─────────────────────────────────────────────────────────╯
    if (environment === 'production') {
      consola.box(
        'Checking periphery registration in diamond (PeripheryRegistry)...'
      )
      const peripheryRegistry = getContract({
        address: deployedContracts['LiFiDiamond'],
        abi: parseAbi([
          'function getPeripheryContract(string) external view returns (address)',
        ]),
        client: publicClient,
      })

      // Only check contracts that are expected to be deployed according to target state
      const targetStateContracts =
        targetState[networkLower]?.production?.LiFiDiamond || {}
      const contractsToCheck = Object.keys(targetStateContracts).filter(
        (contract) =>
          corePeriphery.includes(contract) ||
          Object.keys(whitelistPeripheryFunctions).includes(contract)
      )

      if (contractsToCheck.length > 0) {
        const addresses = await Promise.all(
          contractsToCheck.map((c) =>
            peripheryRegistry.read.getPeripheryContract([c])
          )
        )

        for (const periphery of contractsToCheck) {
          const peripheryAddress = deployedContracts[periphery]
          if (!peripheryAddress)
            logError(`Periphery contract ${periphery} not deployed `)
          else if (!addresses.includes(getAddress(peripheryAddress))) {
            // skip the registration check for LiFiTimelockController (no need to register it)
            if (periphery === 'LiFiTimelockController') continue
            logError(
              `Periphery contract ${periphery} not registered in Diamond`
            )
          } else
            consola.success(
              `Periphery contract ${periphery} registered in Diamond`
            )
        }
      }
    } else {
      consola.info(
        'Skipping periphery registration checks for staging environment'
      )
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                   Check whitelisted addresses           │
    //          ╰─────────────────────────────────────────────────────────╯
    // Check if whitelist configuration exists for this network
    try {
      const hasDexWhitelistConfig =
        (
          whitelistConfig.DEXS as Array<{
            contracts?: Record<string, unknown[]>
          }>
        )?.some(
          (dex) =>
            dex.contracts?.[networkLower] &&
            dex.contracts[networkLower].length > 0
        ) ?? false

      const hasPeripheryWhitelistConfig =
        (whitelistConfig.PERIPHERY?.[networkLower]?.length ?? 0) > 0

      const hasWhitelistConfig =
        hasDexWhitelistConfig || hasPeripheryWhitelistConfig

      if (hasWhitelistConfig) {
        // connect with diamond to get whitelisted addresses
        const whitelistManager = getContract({
          address: deployedContracts['LiFiDiamond'],
          abi: parseAbi([
            'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)',
            'function getAllContractSelectorPairs() external view returns (address[],bytes4[][])',
          ]),
          client: publicClient,
        })

        // Get expected pairs from whitelist.json or whitelist.staging.json file
        const expectedPairs = await getExpectedPairs(
          networkStr as string,
          deployedContracts,
          environment,
          whitelistConfig
        )

        // Get on-chain data once and use for all checks
        const [onChainContracts, onChainSelectors] =
          await whitelistManager.read.getAllContractSelectorPairs()

        await checkWhitelistIntegrity(
          publicClient,
          diamondAddress,
          whitelistManager,
          expectedPairs,
          onChainContracts,
          onChainSelectors
        )
      } else {
        consola.info(
          'No whitelist configuration found for this network, skipping whitelist checks'
        )
      }
    } catch (error) {
      logError('Whitelist configuration not available')
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check contract ownership                 │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking ownership...')

    const refundWallet = getAddress(globalConfig.refundWallet)
    const feeCollectorOwner = getAddress(globalConfig.feeCollectorOwner)

    // Check ERC20Proxy ownership (skip for staging)
    if (environment === 'production') {
      const erc20ProxyOwner = await erc20Proxy.read.owner()
      if (getAddress(erc20ProxyOwner) !== getAddress(deployerWallet))
        logError(
          `ERC20Proxy owner is ${getAddress(
            erc20ProxyOwner
          )}, expected ${getAddress(deployerWallet)}`
        )
      else consola.success('ERC20Proxy owner is correct')
    } else {
      consola.info(
        'Skipping ERC20Proxy ownership check for staging environment'
      )
    }

    // Check that Diamond is owned by Timelock (skip for staging)
    if (environment === 'production') {
      if (deployedContracts.LiFiTimelockController) {
        const timelockAddress = deployedContracts.LiFiTimelockController

        await checkOwnership(
          'LiFiDiamond',
          timelockAddress,
          deployedContracts,
          publicClient
        )
      } else
        consola.error(
          'LiFiTimelockController not deployed, so diamond ownership cannot be verified'
        )
    } else {
      consola.info('Skipping diamond ownership check for staging environment')
    }

    // FeeCollector
    await checkOwnership(
      'FeeCollector',
      feeCollectorOwner,
      deployedContracts,
      publicClient
    )

    // Receiver
    await checkOwnership(
      'Receiver',
      refundWallet,
      deployedContracts,
      publicClient
    )

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check emergency pause config             │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking funding of pauser wallet...')

    const pauserBalance = formatEther(
      await publicClient.getBalance({
        address: pauserWallet,
      })
    )

    if (!pauserBalance || pauserBalance === '0')
      logError(`PauserWallet does not have any native balance`)
    else consola.success(`PauserWallet is funded: ${pauserBalance}`)

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check access permissions                 │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking access permissions...')
    const accessManager = getContract({
      address: deployedContracts['LiFiDiamond'],
      abi: parseAbi([
        'function addressCanExecuteMethod(bytes4,address) external view returns (bool)',
      ]),
      client: publicClient,
    })

    // Refund wallet
    const refundSelectors = globalConfig.approvedSelectorsForRefundWallet as {
      selector: Hex
      name: string
    }[]

    for (const selector of refundSelectors) {
      const normalizedSelector = selector.selector.startsWith('0x')
        ? (selector.selector as Hex)
        : (`0x${selector.selector}` as Hex)

      if (
        !(await accessManager.read.addressCanExecuteMethod([
          normalizedSelector,
          refundWallet,
        ]))
      )
        logError(
          `Refund wallet ${refundWallet} cannot execute ${selector.name} (${normalizedSelector})`
        )
      else
        consola.success(
          `Refund wallet ${refundWallet} can execute ${selector.name} (${normalizedSelector})`
        )
    }

    if (environment === 'production') {
      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   SAFE Configuration                    │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking SAFE configuration...')
      const networkConfig: Network = networks[networkLower]
      if (!networkConfig.safeAddress)
        consola.warn('SAFE address not configured')
      else {
        const safeOwners = globalConfig.safeOwners
        const safeAddress = networkConfig.safeAddress

        try {
          // Import getSafeInfoFromContract from safe-utils.ts
          const { getSafeInfoFromContract } = await import('./safe/safe-utils')

          // Get Safe info directly from the contract
          const safeInfo = await getSafeInfoFromContract(
            publicClient,
            safeAddress
          )

          // Check that each safeOwner is in the Safe
          for (const o in safeOwners) {
            const safeOwner = getAddress(safeOwners[o])
            const isOwner = safeInfo.owners.some(
              (owner) => getAddress(owner) === safeOwner
            )

            if (!isOwner)
              logError(`SAFE owner ${safeOwner} not in SAFE configuration`)
            else
              consola.success(
                `SAFE owner ${safeOwner} is in SAFE configuration`
              )
          }

          // Check that threshold is correct
          if (safeInfo.threshold < BigInt(SAFE_THRESHOLD))
            logError(
              `SAFE signature threshold is ${safeInfo.threshold}, expected at least ${SAFE_THRESHOLD}`
            )
          else
            consola.success(`SAFE signature threshold is ${safeInfo.threshold}`)

          // Show current nonce
          consola.info(`Current SAFE nonce: ${safeInfo.nonce}`)
        } catch (error) {
          logError(`Failed to get SAFE information: ${error}`)
        }
      }
    } else {
      consola.info('Skipping SAFE checks for staging environment')
    }

    finish()
  },
})

const logError = (msg: string) => {
  consola.error(msg)
  errors.push(msg)
}

const getOwnableContract = (address: Address, client: PublicClient) => {
  return getContract({
    address,
    abi: parseAbi(['function owner() external view returns (address)']),
    client,
  })
}

const checkOwnership = async (
  name: string,
  expectedOwner: Address,
  deployedContracts: Record<string, Address>,
  publicClient: PublicClient
) => {
  if (deployedContracts[name]) {
    const contractAddress = deployedContracts[name]
    const owner = await getOwnableContract(
      contractAddress,
      publicClient
    ).read.owner()
    if (getAddress(owner) !== getAddress(expectedOwner))
      logError(
        `${name} owner is ${getAddress(owner)}, expected ${getAddress(
          expectedOwner
        )}`
      )
    else consola.success(`${name} owner is correct`)
  }
}

const checkIsDeployed = async (
  contract: string,
  deployedContracts: Record<string, Address>,
  publicClient: PublicClient
): Promise<boolean> => {
  if (!deployedContracts[contract]) return false

  const code = await publicClient.getCode({
    address: deployedContracts[contract],
  })
  if (code === '0x') return false

  return true
}

const getExpectedPairs = async (
  network: string,
  deployedContracts: Record<string, Address>,
  environment: string,
  whitelistConfig: IWhitelistConfig
): Promise<Array<{ contract: Address; selector: Hex }>> => {
  try {
    const expectedPairs: Array<{ contract: Address; selector: Hex }> = []

    // Both staging and production have the same structure: DEXS at root with contracts nested under network
    for (const dex of (whitelistConfig.DEXS as Array<{
      contracts?: Record<
        string,
        Array<{ address: string; functions?: Record<string, string> }>
      >
    }>) || []) {
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

    // Add periphery contracts from config
    const peripheryConfig = whitelistConfig.PERIPHERY
    if (peripheryConfig && peripheryConfig[network.toLowerCase()]) {
      const networkPeripheryContracts = peripheryConfig[network.toLowerCase()]

      for (const peripheryContract of networkPeripheryContracts) {
        const contractAddr = deployedContracts[peripheryContract.name]
        if (contractAddr) {
          // Use the actual selectors from config instead of ApproveTo-Only Selector (0xffffffff) selector
          for (const selectorInfo of peripheryContract.selectors || []) {
            expectedPairs.push({
              contract: getAddress(contractAddr),
              selector: selectorInfo.selector.toLowerCase() as Hex,
            })
          }
        }
      }
    }

    return expectedPairs
  } catch (error) {
    logError(`Failed to get expected pairs: ${error}`)
    return []
  }
}

// Checks the config.json (source of truth) against on-chain state.
// This function handles all checks for data integrity and synchronization.
const checkWhitelistIntegrity = async (
  publicClient: PublicClient,
  diamondAddress: Address,
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: Address; selector: Hex }>,
  onChainContracts: Address[],
  onChainSelectors: Hex[][]
) => {
  consola.box('Checking Whitelist Integrity (Config vs. On-Chain State)...')

  if (expectedPairs.length === 0) {
    consola.warn('No expected pairs in config. Skipping all checks.')
    return
  }

  // --- 1. Preparation ---
  consola.info('Preparing expected data sets from config...')
  const expectedPairSet = new Set(
    expectedPairs.map(
      (p) => `${p.contract.toLowerCase()}:${p.selector.toLowerCase()}`
    )
  )
  const uniqueContracts = new Set(
    expectedPairs.map((p) => p.contract.toLowerCase())
  )
  const uniqueSelectors = new Set(
    expectedPairs.map((p) => p.selector.toLowerCase())
  )
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${uniqueContracts.size} unique contracts, and ${uniqueSelectors.size} unique selectors.`
  )

  try {
    // --- 2. Check Config vs. On-Chain Contract Functions (Multicall) ---
    consola.start('Step 1/2: Checking Config vs. On-Chain Functions...')

    // Check if multicall3 is available on this chain
    const hasMulticall3 =
      publicClient.chain?.contracts?.multicall3 !== undefined

    let granularResults: boolean[]
    if (hasMulticall3) {
      // Use multicall if available
      const granularMulticall = expectedPairs.map((pair) => ({
        address: whitelistManager.address,
        abi: whitelistManager.abi,
        functionName: 'isContractSelectorWhitelisted',
        args: [pair.contract, pair.selector],
      }))
      granularResults = await publicClient.multicall({
        contracts: granularMulticall,
        allowFailure: false,
      })
    } else {
      // Fallback to individual calls if multicall3 is not available
      consola.info(
        'Multicall3 not available on this chain, using individual calls...'
      )
      granularResults = await Promise.all(
        expectedPairs.map((pair) =>
          whitelistManager.read.isContractSelectorWhitelisted([
            pair.contract,
            pair.selector,
          ])
        )
      )
    }

    let granularFails = 0
    granularResults.forEach((isWhitelisted, index) => {
      if (isWhitelisted === false) {
        const pair = expectedPairs[index]
        logError(
          `Source of Truth FAILED: ${pair.contract} / ${pair.selector} is 'false'.`
        )
        granularFails++
      }
    })
    if (granularFails === 0)
      consola.success(
        'Source of Truth (isContractSelectorWhitelisted) is synced.'
      )
  } catch (error) {
    logError(`Failed during functional checks: ${error.message}`)
  }

  // --- 3. Check Config vs. Getter Arrays ---
  consola.start('Step 2/2: Checking Config vs. Getter Arrays...')
  try {
    // Check pair array: getAllContractSelectorPairs
    const onChainPairSet = new Set<string>()
    for (let i = 0; i < onChainContracts.length; i++) {
      const contract = onChainContracts[i].toLowerCase()
      for (const selector of onChainSelectors[i]) {
        onChainPairSet.add(`${contract}:${selector.toLowerCase()}`)
      }
    }
    const missingPairsList: string[] = []
    const stalePairsList: string[] = []
    for (const expected of expectedPairSet) {
      if (!onChainPairSet.has(expected)) missingPairsList.push(expected)
    }
    for (const onChain of onChainPairSet) {
      if (!expectedPairSet.has(onChain)) stalePairsList.push(onChain)
    }
    if (missingPairsList.length === 0 && stalePairsList.length === 0) {
      consola.success(
        `Pair Array (getAllContractSelectorPairs) is synced. (${onChainPairSet.size} pairs)`
      )
    } else {
      if (missingPairsList.length > 0) {
        logError(
          `Pair Array is missing ${missingPairsList.length} pairs from config:`
        )
        missingPairsList.forEach((pair) => {
          const [contract, selector] = pair.split(':')
          consola.error(`  Missing: ${contract} / ${selector}`)
        })
        consola.info(`\n💡 To fix run diamondSyncWhitelist script`)
      }
      if (stalePairsList.length > 0) {
        logError(
          `Pair Array has ${stalePairsList.length} stale pairs not in config:`
        )
        stalePairsList.forEach((pair) => {
          const [contract, selector] = pair.split(':')
          consola.error(`  Stale: ${contract} / ${selector}`)
        })
        consola.info(
          `\n💡 To fix stale pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist <network> <environment>`
        )
      }
    }
  } catch (error) {
    logError(`Failed during getter array checks: ${error.message}`)
  }
}

const finish = () => {
  // this line ensures that all logs are actually written before the script ends
  process.stdout.write('', () => process.stdout.end())
  if (errors.length) {
    consola.error(`${errors.length} Errors found in deployment`)
    process.exit(1)
  } else {
    consola.success('Deployment checks passed')
    process.exit(0)
  }
}

runMain(main)
