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
  },
  async run({ args }) {
    const { network } = args

    // Skip tronshasta testnet but allow tron mainnet
    if (network.toLowerCase() === 'tronshasta') {
      consola.info('Health checks are not implemented for Tron Shasta testnet.')
      consola.info('Skipping all tests.')
      process.exit(0)
    }

    // Determine if we're working with Tron mainnet
    const isTron = network.toLowerCase() === 'tron'

    const { default: deployedContracts } = await import(
      `../../deployments/${network.toLowerCase()}.json`
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

    const nonCoreFacets = Object.keys(
      targetStateJson[network.toLowerCase()].production.LiFiDiamond
    ).filter((k) => {
      return (
        !coreFacetsToCheck.includes(k) &&
        !corePeriphery.includes(k) &&
        k !== 'LiFiDiamond' &&
        k.includes('Facet')
      )
    })

    const globalConfig = await import('../../config/global.json')
    const networksConfig = await import('../../config/networks.json')

    let publicClient: PublicClient | undefined
    let tronWeb: TronWeb | undefined

    if (isTron)
      tronWeb = initTronWeb(
        'mainnet',
        undefined,
        networksConfig[network].rpcUrl
      )
    else {
      const chain = getViemChainForNetworkName(network.toLowerCase())
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

    //          ╭─────────────────────────────────────────────────────────╮
    //          │          Check that all facets are registered           │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking facets registered in diamond...')

    let registeredFacets: string[] = []
    try {
      if (isTron) {
        // Use troncast for Tron
        // Diamond address in deployments is already in Tron format
        const rpcUrl = networksConfig[network].rpcUrl
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
      } else if (networksConfig[network.toLowerCase()].rpcUrl && publicClient) {
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

    // Skip remaining checks for Tron as they require specific implementations
    if (isTron) {
      consola.info(
        '\nNote: Advanced checks (DEXs, permissions, SAFE) are not yet implemented for Tron'
      )
      finish()
      return
    }

    const deployerWallet = getAddress(globalConfig.deployerWallet)

    // Check Executor authorization in ERC20Proxy
    const erc20Proxy = getContract({
      address: deployedContracts['ERC20Proxy'],
      abi: parseAbi([
        'function authorizedCallers(address) external view returns (bool)',
        'function owner() external view returns (address)',
      ]),
      client: publicClient,
    })

    const executorAddress = deployedContracts['Executor']
    const isExecutorAuthorized = await erc20Proxy.read.authorizedCallers([
      executorAddress,
    ])

    if (!isExecutorAuthorized)
      logError('Executor is not authorized in ERC20Proxy')
    else consola.success('Executor is authorized in ERC20Proxy')

    //          ╭─────────────────────────────────────────────────────────╮
    //          │          Check registered periphery contracts           │
    //          ╰─────────────────────────────────────────────────────────╯
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
      targetState[network]?.production?.LiFiDiamond || {}
    const contractsToCheck = Object.keys(targetStateContracts).filter(
      (contract) =>
        corePeriphery.includes(contract) ||
        Object.keys(whitelistPeripheryFunctions).includes(contract)
    )

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
        logError(`Periphery contract ${periphery} not registered in Diamond`)
      } else
        consola.success(`Periphery contract ${periphery} registered in Diamond`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                   Check whitelisted addresses           │
    //          ╰─────────────────────────────────────────────────────────╯
    if (expectedWhitelistedAddresses) {
      consola.box('Checking whitelisted addresses in diamond...')

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
          'function isMigrated() external view returns (bool)',
        ]),
        client: publicClient,
      })

      //          ╭─────────────────────────────────────────────────────────╮
      //          │        Check whitelisted contract/selectors             │
      //          ╰─────────────────────────────────────────────────────────╯

      // We don't check the migrated field value because:
      // - migrated = false: Fresh deployments (granular system from start) OR pre-migration contracts
      // - migrated = true: Only post-migration contracts (after calling migrate() function)
      // The migration status doesn't determine checking method - WhitelistManagerFacet should be always deployed
      // NOTE: The migrate() function should be removed after migration is complete on all chains
      consola.box('Checking granular contract-selector whitelist...')

      //          ╭─────────────────────────────────────────────────────────╮
      //          │              Check granular contract-selector pairs      │
      //          ╰─────────────────────────────────────────────────────────╯

      await checkGranularWhitelist(whitelistManager, network, deployedContracts)

      //          ╭─────────────────────────────────────────────────────────╮
      //          │        Verify backward compatibility synchronization    │
      //          ╰─────────────────────────────────────────────────────────╯

      await verifyBackwardCompatibilitySync(
        whitelistManager,
        await getExpectedPairs(network, deployedContracts)
      )

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                Check legacy compatibility               │
      //          ╰─────────────────────────────────────────────────────────╯

      await checkLegacyCompatibility(whitelistManager)

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                Check contract ownership                 │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking ownership...')

      const refundWallet = getAddress(globalConfig.refundWallet)
      const feeCollectorOwner = getAddress(globalConfig.feeCollectorOwner)

      // Check ERC20Proxy ownership
      const erc20ProxyOwner = await erc20Proxy.read.owner()
      if (getAddress(erc20ProxyOwner) !== getAddress(deployerWallet))
        logError(
          `ERC20Proxy owner is ${getAddress(
            erc20ProxyOwner
          )}, expected ${getAddress(deployerWallet)}`
        )
      else consola.success('ERC20Proxy owner is correct')

      // Check that Diamond is owned by Timelock
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

      for (const selector of approveSelectors)
        if (
          !(await accessManager.read.addressCanExecuteMethod([
            selector.selector,
            deployerWallet,
          ]))
        )
          logError(
            `Deployer wallet ${deployerWallet} cannot execute ${selector.name} (${selector.selector})`
          )
        else
          consola.success(
            `Deployer wallet ${deployerWallet} can execute ${selector.name} (${selector.selector})`
          )

      // Refund wallet
      const refundSelectors = globalConfig.approvedSelectorsForRefundWallet as {
        selector: Hex
        name: string
      }[]

      for (const selector of refundSelectors)
        if (
          !(await accessManager.read.addressCanExecuteMethod([
            selector.selector,
            refundWallet,
          ]))
        )
          logError(
            `Refund wallet ${refundWallet} cannot execute ${selector.name} (${selector.selector})`
          )
        else
          consola.success(
            `Refund wallet ${refundWallet} can execute ${selector.name} (${selector.selector})`
          )

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   SAFE Configuration                    │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking SAFE configuration...')
      const networkConfig: Network = networks[network.toLowerCase()]
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

      finish()
    } else {
      logError('No whitelisted addresses configured')
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
  deployedContracts: Record<string, Address>
): Promise<Array<{ contract: Address; selector: Hex }>> => {
  try {
    // Load whitelist.json for DEX contracts
    const whitelistConfig = await import(`../../config/whitelist.json`)
    const networkConfig = whitelistConfig[network.toLowerCase()]

    const expectedPairs: Array<{ contract: Address; selector: Hex }> = []

    // Add DEX contracts from whitelist.json
    if (networkConfig) {
      for (const dex of networkConfig.DEXS || []) {
        for (const contract of dex.contracts?.[network.toLowerCase()] || []) {
          const contractAddr = getAddress(contract.address)
          const functions = contract.functions || {}

          if (Object.keys(functions).length === 0) {
            // Contract with no specific functions uses marker selector
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
    }

    // Add periphery contracts that are deployed
    const peripheryContracts = [
      'FeeCollector',
      'FeeForwarder',
      'Executor',
      'ERC20Proxy',
      'Receiver',
    ]
    for (const contractName of peripheryContracts) {
      const contractAddr = deployedContracts[contractName]
      if (contractAddr) {
        // Periphery contracts use marker selector for backward compatibility
        expectedPairs.push({
          contract: getAddress(contractAddr),
          selector: '0xffffffff' as Hex,
        })
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
  network: string,
  deployedContracts: Record<string, Address>
) => {
  consola.box('Checking granular contract-selector whitelist...')

  try {
    // Get expected pairs from config
    const expectedPairs = await getExpectedPairs(network, deployedContracts)

    if (expectedPairs.length === 0) {
      logError(`No whitelist configuration found for network ${network}`)
      return
    }

    // Check each expected contract-selector pair using the granular system
    let missingPairs = 0
    let verifiedPairs = 0

    for (const pair of expectedPairs) {
      try {
        const isWhitelisted =
          await whitelistManager.read.isContractSelectorWhitelisted([
            pair.contract,
            pair.selector,
          ])

        if (!isWhitelisted) {
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
      `Verified ${verifiedPairs} contract-selector pairs using granular system`
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

const verifyBackwardCompatibilitySync = async (
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: Address; selector: Hex }>
) => {
  consola.box('Verifying backward compatibility synchronization...')

  try {
    // Get unique contracts from expected pairs
    const uniqueContracts = new Set(
      expectedPairs.map((p) => p.contract.toLowerCase())
    )

    // Check that each contract is properly synchronized in the global arrays
    let syncIssues = 0

    for (const contractAddr of uniqueContracts) {
      const isAddressWhitelisted =
        await whitelistManager.read.isAddressWhitelisted([contractAddr])
      if (!isAddressWhitelisted) {
        logError(
          `Contract ${contractAddr} not synchronized in global whitelist (backward compatibility issue)`
        )
        syncIssues++
      }
    }

    // Check that global arrays are properly populated
    const globalAddresses =
      await whitelistManager.read.getWhitelistedAddresses()
    const globalSelectors =
      await whitelistManager.read.getWhitelistedFunctionSelectors()

    consola.success(
      `Global arrays synchronized: ${globalAddresses.length} addresses, ${globalSelectors.length} selectors`
    )

    if (syncIssues === 0) {
      consola.success('Backward compatibility synchronization verified')
    } else {
      logError(`Found ${syncIssues} synchronization issues`)
    }
  } catch (error) {
    logError(`Failed to verify backward compatibility sync: ${error}`)
  }
}

const checkLegacyCompatibility = async (
  whitelistManager: ReturnType<typeof getContract>
) => {
  consola.box('Checking legacy compatibility...')

  try {
    // Test that legacy functions still work
    const legacyAddresses =
      await whitelistManager.read.getWhitelistedAddresses()
    const legacySelectors =
      await whitelistManager.read.getWhitelistedFunctionSelectors()

    consola.success(
      `Legacy compatibility maintained: ${legacyAddresses.length} addresses, ${legacySelectors.length} selectors`
    )

    // Verify that legacy contract checks work
    if (legacyAddresses.length > 0) {
      const testAddress = legacyAddresses[0]
      const isContractAllowed =
        await whitelistManager.read.isAddressWhitelisted([testAddress])

      if (isContractAllowed) {
        consola.success(`Legacy contract check works for ${testAddress}`)
      } else {
        logError(`Legacy contract check failed for ${testAddress}`)
      }
    }

    // Verify that legacy selector checks work
    if (legacySelectors.length > 0) {
      const testSelector = legacySelectors[0]
      const isSelectorAllowed =
        await whitelistManager.read.isFunctionSelectorWhitelisted([
          testSelector,
        ])

      if (isSelectorAllowed) {
        consola.success(`Legacy selector check works for ${testSelector}`)
      } else {
        logError(`Legacy selector check failed for ${testSelector}`)
      }
    }
  } catch (error) {
    logError(`Legacy compatibility check failed: ${error}`)
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
