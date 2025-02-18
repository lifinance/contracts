// @ts-nocheck
import { consola } from 'consola'
import { $, spinner } from 'zx'
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
import { coreFacets, pauserWallet } from '../../config/global.json'

const SAFE_THRESHOLD = 3

const louperCmd = 'louper-cli'

const corePeriphery = [
  'ERC20Proxy',
  'Executor',
  'FeeCollector',
  'LiFiDEXAggregator',
  'Receiver',
  'TokenWrapper',
]

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
    if ((await $`${louperCmd}`.exitCode) !== 0) {
      const answer = await consola.prompt(
        'Louper CLI is required but not installed. Would you like to install it now?',
        {
          type: 'confirm',
        }
      )
      if (answer) {
        await spinner(
          'Installing...',
          () => $`npm install -g @mark3labs/louper-cli`
        )
      } else {
        consola.error('Louper CLI is required to run this script')
        process.exit(1)
      }
    }

    const { network } = args
    const deployedContracts = await import(
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
    const dexs = (await import(`../../config/dexs.json`))[
      network.toLowerCase()
    ] as Address[]

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
      const facetsResult =
        await $`${louperCmd} inspect diamond -a ${diamondAddress} -n ${network} --json`
      registeredFacets = JSON.parse(facetsResult.stdout).facets.map(
        (f: { name: string }) => f.name
      )
    } catch (error) {
      consola.warn(
        'Unable to parse louper output - skipping facet registration check'
      )
      consola.debug('Error:', error)
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
    consola.box('Checking periphery contracts...')
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
    consola.box('Checking periphery contracts registered in diamond...')
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
      if (!addresses.includes(getAddress(deployedContracts[periphery]))) {
        logError(`Periphery contract ${periphery} not registered in Diamond`)
      } else {
        consola.success(`Periphery contract ${periphery} registered in Diamond`)
      }
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                   Check approved DEXs                   │
    //          ╰─────────────────────────────────────────────────────────╯
    if (dexs) {
      consola.box('Checking DEXs approved in diamond...')
      const dexManager = getContract({
        address: deployedContracts['LiFiDiamond'],
        abi: parseAbi([
          'function approvedDexs() external view returns (address[])',
          'function isFunctionApproved(bytes4) external returns (bool)',
        ]),
        client: publicClient,
      })
      const approvedDexs = await dexManager.read.approvedDexs()

      // Loop through DEXs excluding the address for FeeCollector, LiFiDEXAggregator and TokenWrapper
      let numMissing = 0
      for (const dex of dexs.filter(
        (d) => !corePeriphery.includes(getAddress(d))
      )) {
        if (!approvedDexs.includes(getAddress(dex))) {
          logError(`DEX ${dex} not approved in Diamond`)
          numMissing++
        }
      }

      // Check that FeeCollector, LiFiDEXAggregator and TokenWrapper are included in approvedDexs
      const mustBeWhitelisted = corePeriphery.filter(
        (p) =>
          p === 'FeeCollector' ||
          p === 'LiFiDEXAggregator' ||
          p === 'TokenWrapper'
      )
      for (const f of mustBeWhitelisted) {
        if (!approvedDexs.includes(getAddress(deployedContracts[f]))) {
          logError(`Periphery contract ${f} not approved as a DEX`)
          numMissing++
        } else {
          consola.success(`Periphery contract ${f} approved as a DEX`)
        }
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
        for (let i = 0; i < array.length; i += chunkSize) {
          chunks.push(array.slice(i, i + chunkSize))
        }
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

        for (let i = 0; i < results.length; i++) {
          if (results[i].status !== 'success' || !results[i].result) {
            console.log('Function not approved:', batch[i])
            sigsToApprove.push(batch[i] as Hex)
          }
        }
      }

      if (sigsToApprove.length > 0) {
        logError(`Missing ${sigsToApprove.length} DEX signatures`)
      } else {
        consola.success('No missing signatures.')
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

      // LiFuelFeeCollector
      await checkOwnership(
        'LiFuelFeeCollector',
        rebalanceWallet,
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
      if (!networkConfig.safeAddress || !networkConfig.safeApiUrl) {
        consola.warn('SAFE address not configured')
      } else {
        const safeOwners = globalConfig.safeOwners
        const safeAddress = networkConfig.safeAddress
        const safeApiUrl = networkConfig.safeApiUrl
        const configUrl = `${safeApiUrl}/v1/safes/${safeAddress}`
        const res = await fetch(configUrl)
        const safeConfig = await res.json()

        // Check that each safeOwner is in safeConfig.owners
        for (const o in safeOwners) {
          const safeOwner = getAddress(safeOwners[o])
          if (!safeConfig.owners.includes(safeOwner)) {
            logError(`SAFE owner ${safeOwner} not in SAFE configuration`)
          } else {
            consola.success(`SAFE owner ${safeOwner} is in SAFE configuration`)
          }
        }

        // Check that threshold is correct
        if (safeConfig.threshold < SAFE_THRESHOLD) {
          logError(`SAFE signature threshold is less than ${SAFE_THRESHOLD}`)
        } else {
          consola.success(`SAFE signature threshold is ${safeConfig.threshold}`)
        }
      }

      finish()
    } else {
      logError('No dexs configured')
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
  } else {
    consola.success('Deployment checks passed')
  }
}

runMain(main)
