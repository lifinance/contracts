// @ts-nocheck
import { consola } from 'consola'
import { $, spinner } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as chains from 'viem/chains'
import {
  Address,
  Chain,
  Hex,
  PublicClient,
  createPublicClient,
  getAddress,
  getContract,
  http,
  parseAbi,
} from 'viem'

const chainNameMappings: Record<string, string> = {
  zksync: 'zkSync',
  polygonzkevm: 'polygonZkEvm',
  immutablezkevm: 'immutableZkEvm',
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

// TODO: remove this and import from ./utils/viemScriptHelpers.ts instead (did not work when I tried it)
export const getViemChainForNetworkName = (networkName: string): Chain => {
  const chainName = chainNameMappings[networkName] || networkName
  const chain: Chain = chainMap[chainName]

  if (!chain)
    throw new Error(
      `Chain ${networkName} (aka '${chainName}', if a mapping exists) not supported by viem or requires name mapping. Check if you can find your chain here: https://github.com/wevm/viem/tree/main/src/chains/definitions`
    )

  return chain
}

const SAFE_THRESHOLD = 3

const louperCmd = 'louper-cli'

const coreFacets = [
  'DiamondCutFacet',
  'DiamondLoupeFacet',
  'OwnershipFacet',
  'WithdrawFacet',
  'DexManagerFacet',
  'PeripheryRegistryFacet',
  'AccessManagerFacet',
  'PeripheryRegistryFacet',
  'GenericSwapFacet',
  'GenericSwapFacetV3',
  'LIFuelFacet',
  'CalldataVerificationFacet',
  'StandardizedCallFacet',
]

const corePeriphery = [
  'ERC20Proxy',
  'Executor',
  'Receiver',
  'FeeCollector',
  'LiFuelFeeCollector',
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
        k.endsWith('Facet')
      )
    })
    const dexs = (await import(`../../config/dexs.json`))[
      network.toLowerCase()
    ] as Address[]

    const globalConfig = await import('../../config/global.json')

    const chain = getViemChainForNetworkName(network)

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

    const string = `${louperCmd} inspect diamond -a ${diamondAddress} -n ${network} --json`
    console.log(`string: ${string}`)
    const facetsResult =
      await $`${louperCmd} inspect diamond -a ${diamondAddress} -n ${network} --json`

    const registeredFacets = JSON.parse(facetsResult.stdout).facets.map(
      (f: { name: string }) => f.name
    )

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
        ]),
        client: publicClient,
      })
      const approvedDexs = await dexManager.read.approvedDexs()

      // Loop through dexs excluding the address for FeeCollector, LiFuelFeeCollector and ServiceFeeCollector and TokenWrapper
      let numMissing = 0
      for (const dex of dexs.filter(
        (d) => !corePeriphery.includes(getAddress(d))
      )) {
        if (!approvedDexs.includes(getAddress(dex))) {
          logError(`Dex ${dex} not approved in Diamond`)
          numMissing++
        }
      }

      // Check that FeeCollector, LiFuelFeeCollector and ServiceFeeCollector and TokenWrapper are included in approvedDexs
      const feeCollectors = corePeriphery.filter(
        (p) =>
          p === 'FeeCollector' ||
          p === 'LiFuelFeeCollector' ||
          p === 'TokenWrapper'
      )
      for (const f of feeCollectors) {
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
      //          │                Check contract ownership                 │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking ownership...')

      const withdrawWallet = getAddress(globalConfig.withdrawWallet)
      const rebalanceWallet = getAddress(globalConfig.lifuelRebalanceWallet)
      const refundWallet = getAddress(globalConfig.refundWallet)

      // Check that Diamond is owned by SAFE
      if (globalConfig.safeAddresses[network.toLowerCase()]) {
        const safeAddress = globalConfig.safeAddresses[network.toLowerCase()]
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
      const deployerWallet = getAddress(globalConfig.deployerWallet)
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
      if (
        !globalConfig.safeAddresses[network.toLowerCase()] ||
        !globalConfig.safeApiUrls[network.toLowerCase()]
      ) {
        consola.warn('SAFE address not configured')
      } else {
        const safeOwners = globalConfig.safeOwners
        const safeAddress = globalConfig.safeAddresses[network.toLowerCase()]
        const safeApiUrl = globalConfig.safeApiUrls[network.toLowerCase()]
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
          logError(`SAFE signtaure threshold is less than ${SAFE_THRESHOLD}`)
        } else {
          consola.success(`SAFE signtaure threshold is ${safeConfig.threshold}`)
        }
      }

      finish()
    } else {
      logError('No dexs configured')
    }
  },
})

const logError = (string: string) => {
  consola.error(string)
  errors.push(string)
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
