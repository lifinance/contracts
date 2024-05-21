import { consola } from 'consola'
import { $ } from 'zx'
import { defineCommand, runMain } from 'citty'
import * as chains from 'viem/chains'
import {
  Address,
  Chain,
  createPublicClient,
  getAddress,
  getContract,
  http,
  parseAbi,
} from 'viem'

const louperCmd = 'louper-cli'

const coreFacets = [
  'DiamondCutFacet',
  'DiamondLoupeFacet',
  'OwnershipFacet',
  'WithdrawFacet',
  'DexManagerFacet',
  'PeripheryRegistryFacet',
  'AccessManagerFacet',
]

const corePeriphery = [
  'ERC20Proxy',
  'Executor',
  'Receiver',
  'FeeCollector',
  'LiFuelFeeCollector',
  'ServiceFeeCollector',
  'TokenWrapper',
]

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
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
  },
  async run({ args }) {
    const { network } = args
    const deployedContracts = await import(
      `../../deployments/${network.toLowerCase()}.json`
    )
    const dexs = (await import(`../../config/dexs.json`))[
      network.toLowerCase()
    ] as Address[]

    const chain = chainMap[network]
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(),
    })

    consola.info('Running post deployment checks...\n')

    // Check core facets
    consola.box('Checking Core Facets...')
    for (const facet of coreFacets) {
      if (!deployedContracts[facet]) {
        logError(`Facet ${facet} not deployed`)
        continue
      }

      consola.success(`Facet ${facet} deployed`)
    }

    // Checking Diamond Contract
    consola.box('Checking diamond Contract...')
    if (!deployedContracts['LiFiDiamond']) {
      logError(`LiFiDiamond not deployed`)
      finish()
    } else {
      consola.success('LiFiDiamond deployed')
    }

    const diamondAddress = deployedContracts['LiFiDiamond']

    // Check that core facets are registered
    consola.box('Checking facets registered in diamond...')
    $.quiet = true
    const facetsResult =
      await $`${louperCmd} inspect diamond -a ${diamondAddress} -n ${network} --json`

    const resgisteredFacets = JSON.parse(facetsResult.stdout).facets.map(
      (f: { name: string }) => f.name
    )

    for (const facet of coreFacets) {
      if (!resgisteredFacets.includes(facet)) {
        logError(`Facet ${facet} not registered in Diamond`)
      } else {
        consola.success(`Facet ${facet} registered in Diamond`)
      }
    }

    // Check that core periphery facets are deployed
    consola.box('Checking periphery contracts...')
    for (const contract of corePeriphery) {
      if (!deployedContracts[contract]) {
        logError(`Periphery contract ${contract} not deployed`)
        continue
      }

      consola.success(`Periphery contract ${contract} deployed`)
    }

    // Check that periphery contracts are registered by calling the diamond with 'getPeripheryContract(string) returns (address)'
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

    for (let periphery of corePeriphery) {
      if (!addresses.includes(getAddress(deployedContracts[periphery]))) {
        logError(`Periphery contract ${periphery} not registered in Diamond`)
      } else {
        consola.success(`Periphery contract ${periphery} registered in Diamond`)
      }
    }

    if (dexs && dexs.length) {
      // Check that all configured dexs are approved by calling the diamond with 'appovedDexs() returns (address[])'
      consola.box('Checking dexs approved in diamond...')
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
      for (let dex of dexs.filter(
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
          p === 'ServiceFeeCollector' ||
          p === 'TokenWrapper'
      )
      for (let f of feeCollectors) {
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
      finish()
    }
  },
})

const logError = (string: string) => {
  consola.error(string)
  errors.push(string)
}

const finish = () => {
  if (errors.length) {
    consola.error(`${errors.length} Errors found in deployment`)
  } else {
    consola.success('Deployment checks passed')
  }
}

runMain(main)
