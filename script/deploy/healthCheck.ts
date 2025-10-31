// @ts-nocheck
import { execSync } from 'child_process'

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
    const targetStateJson = await import(
      `../../script/deploy/_targetState.json`
    )

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
      // Check if DEXS exist and have contracts for this network
      // Both staging and production have DEXS at root level with contracts nested under network
      const hasWhitelistConfig =
        (
          whitelistConfig.DEXS as Array<{
            contracts?: Record<string, unknown[]>
          }>
        )?.some(
          (dex) =>
            dex.contracts?.[networkLower] &&
            dex.contracts[networkLower].length > 0
        ) ?? false

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

        //          ╭─────────────────────────────────────────────────────────╮
        //          │    Check whitelisted granular contract-selector pairs   │
        //          ╰─────────────────────────────────────────────────────────╯

        // We don't check the migrated field value because:
        // - migrated = false: Fresh deployments (granular system from start) OR pre-migration contracts
        // - migrated = true: Only post-migration contracts (after calling migrate() function)
        // The migration status doesn't determine checking method - WhitelistManagerFacet should be always deployed
        consola.box('Checking granular contract-selector whitelist...')

        // Get expected pairs from whitelist.json or whitelist.staging.json config file
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

        await checkGranularWhitelist(
          whitelistManager,
          expectedPairs,
          onChainContracts,
          onChainSelectors
        )

        //          ╭─────────────────────────────────────────────────────────╮
        //          │  Verify backward compatibility and legacy system       │
        //          ╰─────────────────────────────────────────────────────────╯

        await verifyBackwardCompatibilityAndLegacy(
          whitelistManager,
          expectedPairs,
          onChainContracts,
          onChainSelectors,
          globalAddresses,
          globalSelectors
        )

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
          consola.info(
            'Skipping diamond ownership check for staging environment'
          )
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

          if (
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
        const refundSelectors =
          globalConfig.approvedSelectorsForRefundWallet as {
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
              const { getSafeInfoFromContract } = await import(
                './safe/safe-utils'
              )

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
                consola.success(
                  `SAFE signature threshold is ${safeInfo.threshold}`
                )

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
      } else {
        consola.info(
          'No whitelist configuration found for this network, skipping whitelist checks'
        )
        finish()
      }
    } catch (error) {
      logError('Whitelist configuration not available')
      finish()
    }
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

const checkGranularWhitelist = async (
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: Address; selector: Hex }>,
  onChainContracts: Address[],
  onChainSelectors: Hex[][]
) => {
  try {
    if (expectedPairs.length === 0) {
      logError(`No whitelist configuration found`)
      return
    }

    // Create a map of on-chain contract-selector pairs for efficient lookup
    const onChainPairs = new Map<string, Set<string>>()
    for (let i = 0; i < onChainContracts.length; i++) {
      const contract = onChainContracts[i].toLowerCase()
      const selectors = onChainSelectors[i]
      const selectorSet = new Set<string>()

      for (const selector of selectors) {
        selectorSet.add(selector.toLowerCase())
      }

      onChainPairs.set(contract, selectorSet)
    }

    consola.success(
      `Retrieved ${onChainContracts.length} contracts with selectors from diamond`
    )

    // Check each expected contract-selector pair
    let missingPairs = 0
    let verifiedPairs = 0

    for (const pair of expectedPairs) {
      try {
        const contractKey = pair.contract.toLowerCase()
        const selectorKey = pair.selector.toLowerCase()

        const contractSelectors = onChainPairs.get(contractKey)

        if (!contractSelectors || !contractSelectors.has(selectorKey)) {
          logError(
            `Contract-selector pair not whitelisted: ${pair.contract} - ${pair.selector}`
          )
          missingPairs++
        } else {
          verifiedPairs++
        }
      } catch (error) {
        logError(
          `Failed to check contract-selector pair: ${pair.contract} - ${pair.selector}`
        )
        missingPairs++
      }
    }

    consola.success(
      `Verified ${verifiedPairs} contract-selector pairs using getAllContractSelectorPairs`
    )

    if (missingPairs === 0) {
      consola.success(
        'All contract-selector pairs properly whitelisted in granular system'
      )
    } else {
      logError(`Found ${missingPairs} missing contract-selector pairs`)
    }
  } catch (error) {
    logError(`Failed to check granular whitelist: ${error}`)
  }
}

const verifyBackwardCompatibilityAndLegacy = async (
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: Address; selector: Hex }>,
  onChainContracts: Address[],
  onChainSelectors: Hex[][],
  globalAddresses: Address[],
  globalSelectors: Hex[]
) => {
  consola.box('Verifying backward compatibility and legacy system...')

  try {
    // Create a set of on-chain contracts for efficient lookup
    const onChainContractSet = new Set(
      onChainContracts.map((addr) => addr.toLowerCase())
    )

    // Count total selectors for logging
    const totalSelectors = onChainSelectors.reduce(
      (sum, selectors) => sum + selectors.length,
      0
    )

    // Get unique contracts from expected pairs
    const uniqueContracts = new Set(
      expectedPairs.map((p) => p.contract.toLowerCase())
    )

    // Check that each expected contract is properly synchronized in the global arrays
    let syncIssues = 0

    for (const contractAddr of uniqueContracts) {
      if (!onChainContractSet.has(contractAddr)) {
        logError(
          `Contract ${contractAddr} not synchronized in global whitelist (backward compatibility issue)`
        )
        syncIssues++
      }
    }

    consola.success(
      `Global arrays synchronized: ${globalAddresses.length} addresses, ${globalSelectors.length} selectors`
    )
    consola.success(
      `Granular system has: ${onChainContracts.length} contracts with ${totalSelectors} total selectors`
    )

    // Analyze selector differences between granular and global systems
    const granularSelectorSet = new Set<string>()
    for (const selectors of onChainSelectors) {
      for (const selector of selectors) {
        granularSelectorSet.add(selector.toLowerCase())
      }
    }

    const globalSelectorSet = new Set<string>()
    for (const selector of globalSelectors) {
      globalSelectorSet.add(selector.toLowerCase())
    }

    const granularUniqueCount = granularSelectorSet.size
    const globalUniqueCount = globalSelectorSet.size

    consola.info(
      `Granular system has ${totalSelectors} total selectors (${granularUniqueCount} unique)`
    )
    consola.info(
      `Global system has ${globalSelectors.length} selectors (${globalUniqueCount} unique)`
    )

    // Check for differences
    const granularOnlySelectors = new Set<string>()
    for (const selector of granularSelectorSet) {
      if (!globalSelectorSet.has(selector)) {
        granularOnlySelectors.add(selector)
      }
    }

    const globalOnlySelectors = new Set<string>()
    for (const selector of globalSelectorSet) {
      if (!granularSelectorSet.has(selector)) {
        globalOnlySelectors.add(selector)
      }
    }

    if (granularOnlySelectors.size > 0 || globalOnlySelectors.size > 0) {
      if (granularOnlySelectors.size > 0) {
        consola.warn(
          `Granular system has ${
            granularOnlySelectors.size
          } selectors not in global: ${Array.from(granularOnlySelectors)
            .slice(0, 5)
            .join(', ')}${granularOnlySelectors.size > 5 ? '...' : ''}`
        )
      }
      if (globalOnlySelectors.size > 0) {
        consola.warn(
          `Global system has ${
            globalOnlySelectors.size
          } selectors not in granular: ${Array.from(globalOnlySelectors)
            .slice(0, 5)
            .join(', ')}${globalOnlySelectors.size > 5 ? '...' : ''}`
        )
      }
      syncIssues++
    }

    // Verify that granular and global systems are in sync
    if (onChainContracts.length !== globalAddresses.length) {
      logError(
        `Granular system has ${onChainContracts.length} contracts but global system has ${globalAddresses.length} addresses`
      )
      syncIssues++
    }

    // Test legacy functions
    consola.success(
      `Legacy compatibility maintained: ${globalAddresses.length} addresses, ${globalSelectors.length} selectors`
    )

    // Verify that all legacy contract checks work
    let legacyContractFailures = 0
    for (const address of globalAddresses) {
      const isContractAllowed =
        await whitelistManager.read.isAddressWhitelisted([address])

      if (!isContractAllowed) {
        logError(`Legacy contract check failed for ${address}`)
        legacyContractFailures++
      }
    }

    if (legacyContractFailures === 0 && globalAddresses.length > 0) {
      consola.success(
        `All ${globalAddresses.length} addresses pass legacy contract checks`
      )
    }

    // Verify that all legacy selector checks work
    let legacySelectorFailures = 0
    for (const selector of globalSelectors) {
      const isSelectorAllowed =
        await whitelistManager.read.isFunctionSelectorWhitelisted([selector])

      if (!isSelectorAllowed) {
        logError(`Legacy selector check failed for ${selector}`)
        legacySelectorFailures++
      }
    }

    if (legacySelectorFailures === 0 && globalSelectors.length > 0) {
      consola.success(
        `All ${globalSelectors.length} selectors pass legacy function checks`
      )
    }

    if (
      syncIssues === 0 &&
      legacyContractFailures === 0 &&
      legacySelectorFailures === 0
    ) {
      consola.success('Backward compatibility and legacy system verified')
    } else {
      const totalIssues =
        syncIssues + legacyContractFailures + legacySelectorFailures
      logError(
        `Found ${totalIssues} issues: ${syncIssues} sync, ${legacyContractFailures} contract checks, ${legacySelectorFailures} selector checks`
      )
    }
  } catch (error) {
    logError(`Failed to verify backward compatibility and legacy: ${error}`)
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
