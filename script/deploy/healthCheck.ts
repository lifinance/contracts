// @ts-nocheck
import { $ } from 'bun'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
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
  autoWhitelistPeripheryContracts,
  coreFacets,
  corePeriphery,
  pauserWallet,
} from '../../config/global.json'
import {
  getViemChainForNetworkName,
  networks,
  type Network,
} from '../utils/viemScriptHelpers'

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
    const { default: deployedContracts } = await import(
      `../../deployments/${network.toLowerCase()}.json`
    )
    const targetStateJson = await import(
      `../../script/deploy/_targetState.json`
    )
    const nonCoreFacets = Object.keys(
      targetStateJson[network.toLowerCase()].production.LiFiDiamond
    ).filter((k) => {
      return (
        !coreFacets.includes(k) &&
        !corePeriphery.includes(k) &&
        k !== 'LiFiDiamond' &&
        k.includes('Facet')
      )
    })
    const expectedWhitelistedAddresses = (
      await import(`../../config/whitelistedAddresses.json`)
    )[network.toLowerCase()] as Address[]

    const globalConfig = await import('../../config/global.json')
    const networksConfig = await import('../../config/networks.json')

    const chain = getViemChainForNetworkName(network.toLowerCase())

    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    consola.info('Running post deployment checks...\n')

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check Diamond Contract                   │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking diamond Contract...')
    const diamondDeployed = await checkIsDeployed(
      'LiFiDiamond',
      deployedContracts,
      publicClient
    )
    if (!diamondDeployed) {
      logError(`LiFiDiamond not deployed`)
      finish()
    } else consola.success('LiFiDiamond deployed')

    const diamondAddress = deployedContracts['LiFiDiamond']

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                    Check core facets                    │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking Core Facets...')
    for (const facet of coreFacets) {
      const isDeployed = await checkIsDeployed(
        facet,
        deployedContracts,
        publicClient
      )
      if (!isDeployed) {
        logError(`Facet ${facet} not deployed`)
        continue
      }

      consola.success(`Facet ${facet} deployed`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │         Check that non core facets are deployed         │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking Non-Core facets...')
    for (const facet of nonCoreFacets) {
      const isDeployed = await checkIsDeployed(
        facet,
        deployedContracts,
        publicClient
      )
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
      if (networksConfig[network.toLowerCase()].rpcUrl) {
        const rpcUrl: string = chain.rpcUrls.default.http
        const rawString =
          await $`cast call "${diamondAddress}" "facets() returns ((address,bytes4[])[])" --rpc-url "${rpcUrl}"`.text()

        const jsonCompatibleString = rawString
          .replace(/\(/g, '[')
          .replace(/\)/g, ']')
          .replace(/0x[0-9a-fA-F]+/g, '"$&"')

        const onChainFacets = JSON.parse(jsonCompatibleString)

        if (Array.isArray(onChainFacets)) {
          // mapping on-chain facet addresses to names in config
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]) => {
              return [address.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets.map(([address]) => {
            return configFacetsByAddress[address.toLowerCase()]
          })
        }
      } else throw new Error('Failed to get rpc from network config file')
    } catch (error) {
      consola.warn('Unable to parse output - skipping facet registration check')
      consola.warn('Error:', error)
    }

    for (const facet of [...coreFacets, ...nonCoreFacets])
      if (!registeredFacets.includes(facet))
        logError(
          `Facet ${facet} not registered in Diamond or possibly unverified`
        )
      else consola.success(`Facet ${facet} registered in Diamond`)

    //          ╭─────────────────────────────────────────────────────────╮
    //          │      Check that core periphery facets are deployed      │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking deploy status of periphery contracts...')
    for (const contract of corePeriphery) {
      const isDeployed = await checkIsDeployed(
        contract,
        deployedContracts,
        publicClient
      )
      if (!isDeployed) {
        logError(`Periphery contract ${contract} not deployed`)
        continue
      }
      consola.success(`Periphery contract ${contract} deployed`)
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
    const addresses = await Promise.all(
      corePeriphery.map((c) => peripheryRegistry.read.getPeripheryContract([c]))
    )

    for (const periphery of corePeriphery) {
      const peripheryAddress = deployedContracts[periphery]
      if (!peripheryAddress)
        logError(`Periphery contract ${periphery} not deployed `)
      else if (!addresses.includes(getAddress(peripheryAddress)))
        logError(`Periphery contract ${periphery} not registered in Diamond`)
      else
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
        ]),
        client: publicClient,
      })

      let onChainWhitelisted: Address[] = []
      try {
        onChainWhitelisted =
          await whitelistManager.read.getWhitelistedAddresses()
      } catch (error) {
        logError('Failed to get whitelisted addresses from chain')
        // Don't skip the checks - we'll still check against the config
      }

      // First check all whitelisted addresses
      for (const cfgAddress of expectedWhitelistedAddresses) {
        if (!cfgAddress) {
          logError(`Encountered undefined whitelisted address.`)
          continue
        }

        try {
          const normalized = getAddress(cfgAddress)
          // Check if the address is a contract
          const code = await publicClient.getCode({ address: normalized })
          if (code === '0x')
            logError(
              `Whitelisted address ${normalized} is not a contract (EOA or AA account after EIP-7702)`
            )
          if (!onChainWhitelisted.includes(normalized))
            logError(
              `Address ${normalized} from whitelist config (whitelistedAddresses.json) is not whitelisted on chain`
            )
        } catch (err) {
          logError(`Invalid whitelisted address in config: ${cfgAddress}`)
        }
      }

      // Then separately check periphery contracts once
      for (const name of autoWhitelistPeripheryContracts) {
        const addr = deployedContracts[name]
        if (!addr) {
          logError(`Periphery contract ${name} not deployed`)
          continue
        }

        const normalized = getAddress(addr)
        if (!onChainWhitelisted.includes(normalized))
          logError(`Periphery contract ${name} not whitelisted`)
        else consola.success(`Periphery contract ${name} whitelisted`)
      }

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   Check approved selectors              │
      //          ╰─────────────────────────────────────────────────────────╯

      consola.box('Checking selectors approved in diamond...')
      // Check if selectors are approved
      const { selectors } = await import(
        `../../config/whitelistedSelectors.json`
      )

      // Get all approved selectors from contract
      const approvedSelectors = await getWhitelistedFunctionSelectors(
        whitelistManager
      )

      // Convert selectors to normalized format for comparison
      const normalizedConfigSelectors = selectors.map(
        (selector) => selector.toLowerCase() as Hex
      )
      const normalizedApprovedSelectors = approvedSelectors.map((selector) =>
        selector.toLowerCase()
      )

      // Find missing selectors in both directions
      const missingInContract = normalizedConfigSelectors.filter(
        (selector) => !normalizedApprovedSelectors.includes(selector)
      )
      const extraInContract = normalizedApprovedSelectors.filter(
        (selector) => !normalizedConfigSelectors.includes(selector)
      )

      if (missingInContract.length > 0) {
        logError(
          `Missing ${missingInContract.length} selectors in contract that are in config:`
        )
        missingInContract.forEach((selector) => consola.info(`  ${selector}`))
      }

      if (extraInContract.length > 0) {
        logError(
          `Found ${extraInContract.length} extra selectors in contract that are not in config:`
        )
        extraInContract.forEach((selector) => consola.info(`  ${selector}`))
      }

      if (missingInContract.length === 0 && extraInContract.length === 0)
        consola.success('All selectors match between config and contract.')

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

const getWhitelistedFunctionSelectors = async (
  whitelistManager: any
): Promise<Hex[]> => {
  try {
    const approvedSelectors =
      await whitelistManager.read.getWhitelistedFunctionSelectors()
    return approvedSelectors
  } catch (error) {
    logError(
      'Failed to get approved function selectors (call to getWhitelistedFunctionSelectors function)'
    )
    return []
  }
}

runMain(main)
