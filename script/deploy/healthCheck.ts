// @ts-nocheck
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  concat,
  createPublicClient,
  formatEther,
  getAddress,
  getContract,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
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
        ? globalConfig.devWallet
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
            'function getWhitelistedAddresses() external view returns (address[])',
            'function isFunctionSelectorWhitelisted(bytes4) external view returns (bool)',
            'function getWhitelistedFunctionSelectors() external view returns (bytes4[])',
            'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)',
            'function isAddressWhitelisted(address) external view returns (bool)',
            'function getWhitelistedSelectorsForContract(address) external view returns (bytes4[])',
            'function getAllContractSelectorPairs() external view returns (address[],bytes4[][])',
            'function isMigrated() external view returns (bool)',
          ]),
          client: publicClient,
        })

        // We don't check the migrated field value because:
        // - migrated = false: Fresh deployments (granular system from start) OR pre-migration contracts
        // - migrated = true: Only post-migration contracts (after calling migrate() function)
        // The migration status doesn't determine checking method - WhitelistManagerFacet should be always deployed

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

        const globalAddresses =
          await whitelistManager.read.getWhitelistedAddresses()
        const globalSelectors =
          await whitelistManager.read.getWhitelistedFunctionSelectors()

        await checkWhitelistIntegrity(
          publicClient,
          diamondAddress,
          whitelistManager,
          expectedPairs,
          globalAddresses,
          globalSelectors,
          onChainContracts,
          onChainSelectors
        )

        //
        //          ╭─────────────────────────────────────────────────────────╮
        //          │            Check legacy selector cleanup                │
        //          ╰─────────────────────────────────────────────────────────╯
        //
        await checkMigrationCleanup(
          whitelistManager,
          publicClient,
          expectedPairs
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

    // Check if deployer wallet is the owner
    const diamondOwner = getContract({
      address: deployedContracts['LiFiDiamond'],
      abi: parseAbi(['function owner() external view returns (address)']),
      client: publicClient,
    })

    const ownerAddress = await diamondOwner.read.owner()
    const isDeployerOwner =
      getAddress(ownerAddress) === getAddress(deployerWallet)

    // Deployer wallet
    const approveSelectors =
      globalConfig.approvedSelectorsForDeployerWallet as {
        selector: Hex
        name: string
      }[]

    for (const selector of approveSelectors) {
      const normalizedSelector = selector.selector.startsWith('0x')
        ? (selector.selector as Hex)
        : (`0x${selector.selector}` as Hex)

      if (isDeployerOwner) {
        // Owner can execute all methods, skip access check
        consola.success(
          `Deployer wallet ${deployerWallet} can execute ${selector.name} (${normalizedSelector}) - owner has full access`
        )
      } else if (
        !(await accessManager.read.addressCanExecuteMethod([
          normalizedSelector,
          deployerWallet,
        ]))
      )
        logError(
          `Deployer wallet ${deployerWallet} cannot execute ${selector.name} (${normalizedSelector})`
        )
      else
        consola.success(
          `Deployer wallet ${deployerWallet} can execute ${selector.name} (${normalizedSelector})`
        )
    }

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

// Checks the config.json (source of truth) against all on-chain states.
// This one function handles all checks for data integrity and synchronization.
const checkWhitelistIntegrity = async (
  publicClient: PublicClient,
  diamondAddress: Address,
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: Address; selector: Hex }>,
  globalAddresses: Address[],
  globalSelectors: Hex[],
  onChainContracts: Address[],
  onChainSelectors: Hex[][]
) => {
  consola.box('Checking Whitelist Integrity (Config vs. All On-Chain State)...')

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
  const expectedContractSet = new Set(
    expectedPairs.map((p) => p.contract.toLowerCase())
  )
  const expectedSelectorSet = new Set(
    expectedPairs.map((p) => p.selector.toLowerCase())
  )
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${expectedContractSet.size} unique contracts, and ${expectedSelectorSet.size} unique selectors.`
  )

  try {
    // --- 2. Check Config vs. Contract Functions (Multicall) ---
    consola.start('Step 1/4: Checking Config vs. On-Chain Functions...')

    // A. Check V2 Source of Truth: isContractSelectorWhitelisted
    const granularMulticall = expectedPairs.map((pair) => ({
      address: whitelistManager.address,
      abi: whitelistManager.abi,
      functionName: 'isContractSelectorWhitelisted',
      args: [pair.contract, pair.selector],
    }))
    const granularResults = await publicClient.multicall({
      contracts: granularMulticall,
      allowFailure: false,
    })

    let granularFails = 0
    granularResults.forEach((isWhitelisted, index) => {
      if (isWhitelisted === false) {
        const pair = expectedPairs[index]
        logError(
          `V2 Source of Truth FAILED: ${pair.contract} / ${pair.selector} is 'false'.`
        )
        granularFails++
      }
    })
    if (granularFails === 0)
      consola.success(
        'V2 Source of Truth (isContractSelectorWhitelisted) is synced.'
      )

    // B. Check V1 Legacy: isAddressWhitelisted
    const v1ContractMulticall = Array.from(expectedContractSet).map(
      (contract) => ({
        address: whitelistManager.address,
        abi: whitelistManager.abi,
        functionName: 'isAddressWhitelisted',
        args: [contract as Address],
      })
    )
    const v1ContractResults = await publicClient.multicall({
      contracts: v1ContractMulticall,
      allowFailure: false,
    })

    let v1ContractFails = 0
    v1ContractResults.forEach((isWhitelisted, index) => {
      if (isWhitelisted === false) {
        const contract = Array.from(expectedContractSet)[index]
        logError(
          `V1 Legacy FAILED: isAddressWhitelisted(${contract}) is 'false'.`
        )
        v1ContractFails++
      }
    })
    if (v1ContractFails === 0)
      consola.success('V1 Legacy (isAddressWhitelisted) is synced.')

    // C. Check V1 Legacy: isFunctionSelectorWhitelisted
    const v1SelectorMulticall = Array.from(expectedSelectorSet).map(
      (selector) => ({
        address: whitelistManager.address,
        abi: whitelistManager.abi,
        functionName: 'isFunctionSelectorWhitelisted',
        args: [selector as Hex],
      })
    )
    const v1SelectorResults = await publicClient.multicall({
      contracts: v1SelectorMulticall,
      allowFailure: false,
    })

    let v1SelectorFails = 0
    v1SelectorResults.forEach((isWhitelisted, index) => {
      if (isWhitelisted === false) {
        const selector = Array.from(expectedSelectorSet)[index]
        logError(
          `V1 Legacy FAILED: isFunctionSelectorWhitelisted(${selector}) is 'false'.`
        )
        v1SelectorFails++
      }
    })
    if (v1SelectorFails === 0)
      consola.success('V1 Legacy (isFunctionSelectorWhitelisted) is synced.')
  } catch (error) {
    logError(`Failed during functional checks: ${error.message}`)
  }

  // --- 3. Check Config vs. Getter Arrays ---
  consola.start('Step 2/4: Checking Config vs. Getter Arrays...')
  try {
    // A. Check V1 Contracts Array: getWhitelistedAddresses
    const globalAddressesSet = new Set(
      globalAddresses.map((a) => a.toLowerCase())
    )
    let missingContracts = 0
    let staleContracts = 0
    for (const expected of expectedContractSet) {
      if (!globalAddressesSet.has(expected)) missingContracts++
    }
    for (const onChain of globalAddressesSet) {
      if (!expectedContractSet.has(onChain)) staleContracts++
    }
    if (missingContracts === 0 && staleContracts === 0) {
      consola.success(
        `V1 Contract Array (getWhitelistedAddresses) is synced. (${globalAddresses.length} entries)`
      )
    } else {
      if (missingContracts > 0)
        logError(
          `V1 Contract Array is missing ${missingContracts} contracts from config.`
        )
      if (staleContracts > 0)
        logError(
          `V1 Contract Array has ${staleContracts} stale contracts not in config.`
        )
    }

    // B. Check V1 Selectors Array: getWhitelistedFunctionSelectors
    const globalSelectorsSet = new Set(
      globalSelectors.map((s) => s.toLowerCase())
    )
    let missingSelectors = 0
    let staleSelectors = 0
    for (const expected of expectedSelectorSet) {
      if (!globalSelectorsSet.has(expected)) missingSelectors++
    }
    for (const onChain of globalSelectorsSet) {
      if (!expectedSelectorSet.has(onChain)) staleSelectors++
    }
    if (missingSelectors === 0 && staleSelectors === 0) {
      consola.success(
        `V1 Selector Array (getWhitelistedFunctionSelectors) is synced. (${globalSelectors.length} entries)`
      )
    } else {
      if (missingSelectors > 0)
        logError(
          `V1 Selector Array is missing ${missingSelectors} selectors from config.`
        )
      if (staleSelectors > 0)
        logError(
          `V1 Selector Array has ${staleSelectors} stale selectors not in config.`
        )
    }

    // C. Check V2 Pair Array: getAllContractSelectorPairs
    const onChainPairSet = new Set<string>()
    for (let i = 0; i < onChainContracts.length; i++) {
      const contract = onChainContracts[i].toLowerCase()
      for (const selector of onChainSelectors[i]) {
        onChainPairSet.add(`${contract}:${selector.toLowerCase()}`)
      }
    }
    let missingPairs = 0
    let stalePairs = 0
    for (const expected of expectedPairSet) {
      if (!onChainPairSet.has(expected)) missingPairs++
    }
    for (const onChain of onChainPairSet) {
      if (!expectedPairSet.has(onChain)) stalePairs++
    }
    if (missingPairs === 0 && stalePairs === 0) {
      consola.success(
        `V2 Pair Array (getAllContractSelectorPairs) is synced. (${onChainPairSet.size} pairs)`
      )
    } else {
      if (missingPairs > 0)
        logError(`V2 Pair Array is missing ${missingPairs} pairs from config.`)
      if (stalePairs > 0)
        logError(`V2 Pair Array has ${stalePairs} stale pairs not in config.`)
    }
  } catch (error) {
    logError(`Failed during getter array checks: ${error.message}`)
  }

  // --- 4. Check Config vs. Raw Storage Slots ---
  consola.start('Step 3/4: Checking Config vs. Raw Storage Slots...')
  try {
    // --- USER COMMENT: Added NAMESPACE hash ---
    // cast keccak "com.lifi.library.allow.list"
    // 0x7a8ac5d3b7183f220a0602439da45ea337311d699902d1ed11a3725a714e7f1e
    const ALLOW_LIST_NAMESPACE =
      '0x7a8ac5d3b7183f220a0602439da45ea337311d699902d1ed11a3725a714e7f1e' //[pre-commit-checker: not a secret]
    const baseSlot = BigInt(ALLOW_LIST_NAMESPACE)
    const contractAllowListSlot = baseSlot + 0n
    const selectorAllowListSlot = baseSlot + 1n
    const contractsSlot = baseSlot + 2n
    const contractToIndexSlot = baseSlot + 3n
    const selectorToIndexSlot = baseSlot + 4n
    const selectorsSlot = baseSlot + 5n
    const granularListSlot = baseSlot + 6n

    // Check array lengths
    const contractsLengthHex = await publicClient.getStorageAt({
      address: diamondAddress,
      slot: toHex(contractsSlot),
    })
    const contractsLength = parseInt(contractsLengthHex ?? '0x0', 16)
    if (contractsLength === globalAddresses.length) {
      consola.success(
        `Raw contracts[] length (${contractsLength}) matches getter.`
      )
    } else {
      logError(
        `Raw contracts[] length (${contractsLength}) does NOT match getter length (${globalAddresses.length}).`
      )
    }

    const selectorsLengthHex = await publicClient.getStorageAt({
      address: diamondAddress,
      slot: toHex(selectorsSlot),
    })
    const selectorsLength = parseInt(selectorsLengthHex ?? '0x0', 16)
    if (selectorsLength === globalSelectors.length) {
      consola.success(
        `Raw selectors[] length (${selectorsLength}) matches getter.`
      )
    } else {
      logError(
        `Raw selectors[] length (${selectorsLength}) does NOT match getter length (${globalSelectors.length}).`
      )
    }

    // --- Probe all pairs ---
    consola.info(`Probing all ${expectedPairs.length} pairs in raw storage...`)
    let v1ContractFails = 0
    let v1SelectorFails = 0
    let v2ContractIndexFails = 0
    let v2SelectorIndexFails = 0
    let v2GranularFails = 0

    const getMappingSlot = async (key: Hex, baseMappingSlot: bigint) => {
      const slot = keccak256(
        concat([key, pad(toHex(baseMappingSlot), { size: 32 })])
      )
      return publicClient.getStorageAt({ address: diamondAddress, slot })
    }
    const getGranularMappingSlot = async (
      contract: Hex,
      selector: Hex,
      baseMappingSlot: bigint
    ) => {
      const innerSlot = keccak256(
        concat([contract, pad(toHex(baseMappingSlot), { size: 32 })])
      )
      const granularSlot = keccak256(concat([selector, innerSlot]))
      return publicClient.getStorageAt({
        address: diamondAddress,
        slot: granularSlot,
      })
    }

    for (const pair of expectedPairs) {
      const probeContract = pad(pair.contract, { size: 32 })
      const probeSelector = pad(pair.selector, { size: 32, dir: 'right' })

      // Check V1 contractAllowList
      const v1ContractBool = await getMappingSlot(
        probeContract,
        contractAllowListSlot
      )
      if (!v1ContractBool?.endsWith('01')) {
        logError(`Raw V1 contractAllowList FAILED for ${pair.contract}`)
        v1ContractFails++
      }

      // Check V1 selectorAllowList
      const v1SelectorBool = await getMappingSlot(
        probeSelector,
        selectorAllowListSlot
      )
      if (!v1SelectorBool?.endsWith('01')) {
        logError(`Raw V1 selectorAllowList FAILED for ${pair.selector}`)
        v1SelectorFails++
      }

      // Check V2 contractToIndex
      const v2ContractIndex = await getMappingSlot(
        probeContract,
        contractToIndexSlot
      )
      if (parseInt(v2ContractIndex ?? '0x0', 16) === 0) {
        logError(`Raw V2 contractToIndex FAILED for ${pair.contract}`)
        v2ContractIndexFails++
      }

      // Check V2 selectorToIndex
      const v2SelectorIndex = await getMappingSlot(
        probeSelector,
        selectorToIndexSlot
      )
      if (parseInt(v2SelectorIndex ?? '0x0', 16) === 0) {
        logError(`Raw V2 selectorToIndex FAILED for ${pair.selector}`)
        v2SelectorIndexFails++
      }

      // Check V2 granularList (source of truth)
      const v2GranularBool = await getGranularMappingSlot(
        probeContract,
        probeSelector,
        granularListSlot
      )
      if (!v2GranularBool?.endsWith('01')) {
        logError(
          `Raw V2 granularList (Source of Truth) FAILED for ${pair.contract} / ${pair.selector}`
        )
        v2GranularFails++
      }
    }

    // Report Results
    consola.info('Raw storage probe summary:')
    if (v1ContractFails === 0)
      consola.success('Raw V1 contractAllowList is synced')
    else logError(`Raw V1 contractAllowList has ${v1ContractFails} sync errors`)

    if (v1SelectorFails === 0)
      consola.success('Raw V1 selectorAllowList is synced')
    else logError(`Raw V1 selectorAllowList has ${v1SelectorFails} sync errors`)

    if (v2ContractIndexFails === 0)
      consola.success('Raw V2 contractToIndex is synced')
    else
      logError(`Raw V2 contractToIndex has ${v2ContractIndexFails} sync errors`)

    if (v2SelectorIndexFails === 0)
      consola.success('Raw V2 selectorToIndex is synced')
    else
      logError(`Raw V2 selectorToIndex has ${v2SelectorIndexFails} sync errors`)

    if (v2GranularFails === 0)
      consola.success('Raw V2 granular contractSelectorAllowList is synced')
    else
      logError(
        `Raw V2 granular contractSelectorAllowList has ${v2GranularFails} sync errors`
      )
  } catch (error) {
    logError(`Failed to check direct storage: ${error.message}`)
  }
}

/// Check 5: Migration Cleanup
/// Verifies that any selector in `functionSelectorsToRemove.json` that is NOT
/// in the current `whitelist.json` correctly returns `false` from the
/// legacy V1 `isFunctionSelectorWhitelisted()` function.
const checkMigrationCleanup = async (
  whitelistManager: ReturnType<typeof getContract>,
  publicClient: PublicClient,
  expectedPairs: Array<{ contract: Address; selector: Hex }>
) => {
  consola.box('Checking legacy selector cleanup (Migration check)...')

  try {
    // 1. Load functionSelectorsToRemove.json
    const removeJsonPath = path.resolve(
      __dirname,
      '../../config/functionSelectorsToRemove.json'
    )
    const removeFile = fs.readFileSync(removeJsonPath, 'utf8')
    const { functionSelectorsToRemove } = JSON.parse(removeFile) as {
      functionSelectorsToRemove: string[]
    }

    // 2. Create a Set of *expected* selectors from the whitelist config
    const expectedSelectorSet = new Set(
      expectedPairs.map((p) => p.selector.toLowerCase())
    )

    // 3. Create the list of selectors that *must* be false
    const selectorsToCheck: Hex[] = []
    for (const rawSelector of functionSelectorsToRemove) {
      const selector = (
        rawSelector.startsWith('0x') ? rawSelector : `0x${rawSelector}`
      ).toLowerCase() as Hex

      // --- USER COMMENT: Added logic explanation ---
      // We do not expect selectors from whitelist.json to be whitelisted
      if (!expectedSelectorSet.has(selector)) {
        selectorsToCheck.push(selector)
      }
    }

    if (selectorsToCheck.length === 0) {
      consola.warn(
        'No selectors found in functionSelectorsToRemove.json that are not in the current whitelist. Skipping check.'
      )
      return
    }

    consola.info(
      `Checking ${selectorsToCheck.length} selectors from 'functionSelectorsToRemove.json' for proper cleanup...`
    )

    // 4. Use multicall to check isFunctionSelectorWhitelisted (the V1 bool)
    const multicallContracts = selectorsToCheck.map((selector) => ({
      address: whitelistManager.address,
      abi: whitelistManager.abi,
      functionName: 'isFunctionSelectorWhitelisted',
      args: [selector],
    }))

    const results = await publicClient.multicall({
      contracts: multicallContracts,
      allowFailure: false,
    })

    // 5. Report any selectors that are still true
    let staleSelectorErrors = 0
    results.forEach((isStillWhitelisted, index) => {
      if (isStillWhitelisted === true) {
        const selector = selectorsToCheck[index]
        logError(
          `STALE SELECTOR FOUND: ${selector} is still 'true' in V1 selectorAllowList but should have been removed.`
        )
        staleSelectorErrors++
      }
    })

    if (staleSelectorErrors === 0) {
      consola.success(
        `All ${selectorsToCheck.length} selectors were correctly cleaned up.`
      )
    } else {
      logError(
        `Found ${staleSelectorErrors} stale selectors from the migration list.`
      )
    }
  } catch (error) {
    logError(`Failed to check legacy selector cleanup: ${error.message}`)
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
