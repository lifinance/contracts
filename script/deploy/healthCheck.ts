// @ts-nocheck
import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as path from 'path'
import * as fs from 'fs'
import {
  Address,
  Hex,
  PublicClient,
  createPublicClient,
  getAddress,
  formatEther,
  getContract,
  http,
  parseAbi,
} from 'viem'
import {
  Network,
  networks,
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'
import {
  coreFacets,
  corePeriphery,
  autoWhitelistPeripheryContracts,
  pauserWallet,
} from '../../config/global.json'

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
    } else {
      consola.success('LiFiDiamond deployed')
    }

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
    $.quiet = true

    let registeredFacets: string[] = []
    try {
      if (networksConfig[network.toLowerCase()].rpcUrl) {
        const rpcUrl: string = networksConfig[network.toLowerCase()].rpcUrl
        const facetsResult =
          await $`cast call ${diamondAddress} "facets() returns ((address,bytes4[])[])" --rpc-url ${rpcUrl}`
        const rawString = facetsResult.stdout

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

          const onChainFacetAddresses = onChainFacets.map(([address]) =>
            address.toLowerCase()
          )

          const configuredFacetAddresses = Object.keys(configFacetsByAddress)

          registeredFacets = onChainFacets.map(([address]) => {
            return configFacetsByAddress[address.toLowerCase()]
          })
        }
      } else {
        throw new Error('Failed to get rpc from network config file')
      }
    } catch (error) {
      consola.warn('Unable to parse output - skipping facet registration check')
      consola.warn('Error:', error)
    }

    for (const facet of [...coreFacets, ...nonCoreFacets]) {
      if (!registeredFacets.includes(facet)) {
        logError(
          `Facet ${facet} not registered in Diamond or possibly unverified`
        )
      } else {
        consola.success(`Facet ${facet} registered in Diamond`)
      }
    }

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

    if (!isExecutorAuthorized) {
      logError('Executor is not authorized in ERC20Proxy')
    } else {
      consola.success('Executor is authorized in ERC20Proxy')
    }

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
        logError(`Periphery contract ${periphery} not registered in Diamond`)
      } else {
        consola.success(`Periphery contract ${periphery} registered in Diamond`)
      }
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
          'function approvedDexs() external view returns (address[])', // old DexManagerFacet (depricated replaced by WhitelistManagerFacet getWhitelistedAddresses)
          'function getWhitelistedAddresses() external view returns (address[])', // WhitelistManagerFacet
          'function isFunctionApproved(bytes4) external returns (bool)', // WhitelistManagerFacet
          'function getApprovedFunctionSignatures() external view returns (bytes4[])', // WhitelistManagerFacet
        ]),
        client: publicClient,
      })

      let onChainWhitelisted: Address[] = []
      try {
        onChainWhitelisted =
          await whitelistManager.read.getWhitelistedAddresses()
      } catch (error) {
        // If getWhitelistedAddresses fails, try approvedDexs
        try {
          onChainWhitelisted = await whitelistManager.read.approvedDexs()
          logError(
            'Diamond needs to be upgraded from DexManagerFacet to WhitelistManagerFacet'
          )
        } catch (innerError) {
          logError('Failed to get whitelisted addresses and approved dexs')
          finish()
          return
        }
      }

      let numMissing = 0
      for (const cfgAddress of expectedWhitelistedAddresses) {
        if (!cfgAddress) {
          logError(`Encountered undefined whitelisted address.`)
          continue
        }

        try {
          const normalized = getAddress(cfgAddress)
          if (!onChainWhitelisted.includes(normalized)) {
            logError(
              `Whitelisted address ${normalized} not whitelisted in Diamond`
            )
            numMissing++
          }
        } catch (err) {
          logError(`Invalid whitelisted address in config: ${cfgAddress}`)
        }
      }

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
        if (!onChainWhitelisted.includes(normalized)) {
          logError(`Periphery contract ${name} not whitelisted`)
          numMissing++
        } else {
          consola.success(`Periphery contract ${name} whitelisted`)
        }
      }

      consola.info(
        `Found ${numMissing} missing whitelisted address${
          numMissing === 1 ? '' : 's'
        }`
      )

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   Check approved sigs                   │
      //          ╰─────────────────────────────────────────────────────────╯

      consola.box('Checking DEX signatures approved in diamond...')
      // Check if function signatures are approved
      const { sigs } = await import(`../../config/sigs.json`)

      // Get all approved signatures from contract
      const approvedSigs = await getApprovedFunctionSignatures(whitelistManager)

      // Convert sigs to normalized format for comparison
      const normalizedConfigSigs = sigs.map((sig) => sig.toLowerCase() as Hex)
      const normalizedApprovedSigs = approvedSigs.map((sig) =>
        sig.toLowerCase()
      )

      // Find missing sigs in both directions
      const missingInContract = normalizedConfigSigs.filter(
        (sig) => !normalizedApprovedSigs.includes(sig)
      )
      const extraInContract = normalizedApprovedSigs.filter(
        (sig) => !normalizedConfigSigs.includes(sig)
      )

      if (missingInContract.length > 0) {
        logError(
          `Missing ${missingInContract.length} signatures in contract that are in config:`
        )
        missingInContract.forEach((sig) => consola.info(`  ${sig}`))
      }

      if (extraInContract.length > 0) {
        logError(
          `Found ${extraInContract.length} extra signatures in contract that are not in config:`
        )
        extraInContract.forEach((sig) => consola.info(`  ${sig}`))
      }

      if (missingInContract.length === 0 && extraInContract.length === 0) {
        consola.success('All signatures match between config and contract.')
      }

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                Check contract ownership                 │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking ownership...')

      const withdrawWallet = getAddress(globalConfig.withdrawWallet)
      const rebalanceWallet = getAddress(globalConfig.lifuelRebalanceWallet)
      const refundWallet = getAddress(globalConfig.refundWallet)

      // Check ERC20Proxy ownership
      const erc20ProxyOwner = await erc20Proxy.read.owner()
      if (getAddress(erc20ProxyOwner) !== getAddress(deployerWallet)) {
        logError(
          `ERC20Proxy owner is ${getAddress(
            erc20ProxyOwner
          )}, expected ${getAddress(deployerWallet)}`
        )
      } else {
        consola.success('ERC20Proxy owner is correct')
      }

      // Check that Diamond is owned by SAFE
      if (networksConfig[network.toLowerCase()].safeAddress) {
        const safeAddress = networksConfig[network.toLowerCase()].safeAddress

        await checkOwnership(
          'LiFiDiamond',
          safeAddress,
          deployedContracts,
          publicClient
        )
      }

      // FeeCollector
      await checkOwnership(
        'FeeCollector',
        withdrawWallet,
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
      consola.box('Checking emergency pause config...')
      const filePath: string = path.join(
        '.github',
        'workflows',
        'diamondEmergencyPause.yml'
      )

      try {
        const fileContent: string = fs.readFileSync(filePath, 'utf8')

        const networkUpper: string = network.toUpperCase()
        const pattern = new RegExp(
          `ETH_NODE_URI_${networkUpper}\\s*:\\s*\\$\\{\\{\\s*secrets\\.ETH_NODE_URI_${networkUpper}\\s*\\}\\}`
        )

        const exists: boolean = pattern.test(fileContent)

        if (!exists) {
          logError(`Missing ETH_NODE_URI config for ${network} in ${filePath}`)
        } else
          consola.success(
            `Found ETH_NODE_URI_${networkUpper} in diamondEmergencyPause.yml`
          )
      } catch (error: any) {
        logError(`Error checking workflow file: ${error.message}`)
      }
      console.log('')

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

      for (const sig of approveSigs) {
        if (
          !(await accessManager.read.addressCanExecuteMethod([
            sig.sig,
            deployerWallet,
          ]))
        ) {
          logError(
            `Deployer wallet ${deployerWallet} cannot execute ${sig.name} (${sig.sig})`
          )
        } else {
          consola.success(
            `Deployer wallet ${deployerWallet} can execute ${sig.name} (${sig.sig})`
          )
        }
      }

      // Refund wallet
      const refundSigs = globalConfig.approvedSigsForRefundWallet as {
        sig: Hex
        name: string
      }[]

      for (const sig of refundSigs) {
        if (
          !(await accessManager.read.addressCanExecuteMethod([
            sig.sig,
            refundWallet,
          ]))
        ) {
          logError(
            `Refund wallet ${refundWallet} cannot execute ${sig.name} (${sig.sig})`
          )
        } else {
          consola.success(
            `Refund wallet ${refundWallet} can execute ${sig.name} (${sig.sig})`
          )
        }
      }

      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   SAFE Configuration                    │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking SAFE configuration...')
      const networkConfig: Network = networks[network.toLowerCase()]
      if (!networkConfig.safeAddress) {
        consola.warn('SAFE address not configured')
      } else {
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

            if (!isOwner) {
              logError(`SAFE owner ${safeOwner} not in SAFE configuration`)
            } else {
              consola.success(
                `SAFE owner ${safeOwner} is in SAFE configuration`
              )
            }
          }

          // Check that threshold is correct
          if (safeInfo.threshold < BigInt(SAFE_THRESHOLD)) {
            logError(
              `SAFE signature threshold is ${safeInfo.threshold}, expected at least ${SAFE_THRESHOLD}`
            )
          } else {
            consola.success(`SAFE signature threshold is ${safeInfo.threshold}`)
          }

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
    if (getAddress(owner) !== getAddress(expectedOwner)) {
      logError(
        `${name} owner is ${getAddress(owner)}, expected ${getAddress(
          expectedOwner
        )}`
      )
    } else {
      consola.success(`${name} owner is correct`)
    }
  }
}

const checkIsDeployed = async (
  contract: string,
  deployedContracts: Record<string, Address>,
  publicClient: PublicClient
): Promise<boolean> => {
  if (!deployedContracts[contract]) {
    return false
  }
  const code = await publicClient.getCode({
    address: deployedContracts[contract],
  })
  if (code === '0x') {
    return false
  }
  return true
}

const finish = () => {
  if (errors.length) {
    consola.error(`${errors.length} Errors found in deployment`)
    process.exit(1)
  } else {
    consola.success('Deployment checks passed')
    process.exit(0)
  }
}

const getApprovedFunctionSignatures = async (
  whitelistManager: any
): Promise<Hex[]> => {
  try {
    const approvedSigs =
      await whitelistManager.read.getApprovedFunctionSignatures()
    return approvedSigs
  } catch (error) {
    logError('Failed to get approved function signatures')
    return []
  }
}

runMain(main)
