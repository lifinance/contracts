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
  autoWhitelistPeripheryContracts,
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

import {
  getCoreFacets as getTronCoreFacets,
  getTronCorePeriphery,
  checkIsDeployedTron,
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
    const dexs = (await import(`../../config/dexs.json`))[
      network.toLowerCase()
    ] as Address[]

    const globalConfig = await import('../../config/global.json')
    const networksConfig = await import('../../config/networks.json')

    let publicClient: PublicClient | undefined
    let tronWeb: TronWeb | undefined

    if (isTron) tronWeb = initTronWeb('mainnet', networksConfig[network].rpcUrl)
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
        const rawString = execSync(
          `bun troncast call "${diamondAddress}" "facets() returns ((address,bytes4[])[])"`,
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
    const addresses = await Promise.all(
      corePeriphery.map((c) => peripheryRegistry.read.getPeripheryContract([c]))
    )

    for (const periphery of corePeriphery) {
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
    //          │                   Check approved DEXs                   │
    //          ╰─────────────────────────────────────────────────────────╯
    if (dexs) {
      consola.box('Checking DEXs approved in diamond...')

      // connect with diamond to get whitelisted DEXs
      const dexManager = getContract({
        address: deployedContracts['LiFiDiamond'],
        abi: parseAbi([
          'function approvedDexs() external view returns (address[])',
          'function isFunctionApproved(bytes4) external returns (bool)',
        ]),
        client: publicClient,
      })

      const approvedDexs = await dexManager.read.approvedDexs()

      let numMissing = 0

      // Check for each address in dexs.json if it is whitelisted
      for (const dex of dexs) {
        if (!dex) {
          logError(`Encountered undefined DEX address.`)
          continue
        }

        try {
          const normalized = getAddress(dex)
          if (!approvedDexs.includes(normalized)) {
            logError(`DEX ${normalized} not approved in Diamond`)
            numMissing++
          }
        } catch (err) {
          logError(`Invalid DEX address in main check: ${dex}`)
        }
      }

      // Ensure that periphery contracts which are used like DEXs are whitelisted
      for (const name of autoWhitelistPeripheryContracts) {
        // get address from deploy log
        const addr = deployedContracts[name]
        if (!addr) {
          logError(`Periphery contract ${name} not deployed`)
          numMissing++
          continue
        }

        // check if address is whitelisted
        const normalized = getAddress(addr)
        if (!approvedDexs.includes(normalized)) {
          logError(`Periphery contract ${name} not approved as a DEX`)
          numMissing++
        } else consola.success(`Periphery contract ${name} approved as a DEX`)
      }

      consola.info(
        `Found ${numMissing} missing dex${numMissing === 1 ? '' : 's'}`
      )

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   Check approved sigs                   │
      //          ╰─────────────────────────────────────────────────────────╯

      consola.box('Checking DEX signatures approved in diamond...')
      // Check if function signatures are approved
      const { sigs } = await import(`../../config/sigs.json`)

      // Function to split array into chunks
      const chunkArray = <T>(array: T[], chunkSize: number): T[][] => {
        const chunks: T[][] = []
        for (let i = 0; i < array.length; i += chunkSize)
          chunks.push(array.slice(i, i + chunkSize))

        return chunks
      }

      const batchSize = 20
      const sigBatches = chunkArray(sigs, batchSize)

      const sigsToApprove: Hex[] = []

      for (const batch of sigBatches) {
        const calls = batch.map((sig: string) => {
          return {
            ...dexManager,
            functionName: 'isFunctionApproved',
            args: [sig],
          }
        })

        const results = await publicClient.multicall({ contracts: calls })

        for (let i = 0; i < results.length; i++)
          if (results[i].status !== 'success' || !results[i].result) {
            console.log('Function not approved:', batch[i])
            sigsToApprove.push(batch[i] as Hex)
          }
      }

      if (sigsToApprove.length > 0)
        logError(`Missing ${sigsToApprove.length} DEX signatures`)
      else consola.success('No missing signatures.')

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
      const approveSigs = globalConfig.approvedSigsForDeployerWallet as {
        sig: Hex
        name: string
      }[]

      for (const sig of approveSigs)
        if (
          !(await accessManager.read.addressCanExecuteMethod([
            sig.sig,
            deployerWallet,
          ]))
        )
          logError(
            `Deployer wallet ${deployerWallet} cannot execute ${sig.name} (${sig.sig})`
          )
        else
          consola.success(
            `Deployer wallet ${deployerWallet} can execute ${sig.name} (${sig.sig})`
          )

      // Refund wallet
      const refundSigs = globalConfig.approvedSigsForRefundWallet as {
        sig: Hex
        name: string
      }[]

      for (const sig of refundSigs)
        if (
          !(await accessManager.read.addressCanExecuteMethod([
            sig.sig,
            refundWallet,
          ]))
        )
          logError(
            `Refund wallet ${refundWallet} cannot execute ${sig.name} (${sig.sig})`
          )
        else
          consola.success(
            `Refund wallet ${refundWallet} can execute ${sig.name} (${sig.sig})`
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
      logError('No dexs configured')
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

runMain(main)
