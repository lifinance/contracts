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
  zeroAddress,
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
    const dexs = (await import(`../../config/dexs.json`))[
      network.toLowerCase()
    ] as Address[]

    const globalConfig = await import('../../config/global.json')

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
        logError(
          `Facet ${facet} not registered in Diamond or possibly unverified`
        )
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

    for (const periphery of corePeriphery) {
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
          p === 'ServiceFeeCollector' ||
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

      // Check contract ownership
      consola.box('Checking ownership...')

      let owner: Address = zeroAddress
      let contractAddress: Address
      const withdrawWallet = getAddress(globalConfig.withdrawWallet)
      const rebalanceWallet = getAddress(globalConfig.lifuelRebalanceWallet)
      const refundWallet = getAddress(globalConfig.refundWallet)

      // FeeCollector
      if (deployedContracts['FeeCollector']) {
        contractAddress = deployedContracts['FeeCollector']
        owner = await getOwnablContract(
          contractAddress,
          publicClient
        ).read.owner()
        if (owner !== withdrawWallet) {
          logError(`FeeCollector owner is ${owner}, expected ${withdrawWallet}`)
        } else {
          consola.success('FeeCollector owner is correct')
        }
      }

      // LiFuelFeeCollector
      if (deployedContracts['LiFuelFeeCollector']) {
        contractAddress = deployedContracts['LiFuelFeeCollector']
        owner = await getOwnablContract(
          contractAddress,
          publicClient
        ).read.owner()
        if (owner !== rebalanceWallet) {
          logError(
            `LiFuelFeeCollector owner is ${owner}, expected ${rebalanceWallet}`
          )
        } else {
          consola.success('LiFuelFeeCollector owner is correct')
        }
      }

      // Receiver
      if (deployedContracts['Receiver']) {
        contractAddress = deployedContracts['Receiver']
        owner = await getOwnablContract(
          contractAddress,
          publicClient
        ).read.owner()
        if (owner !== refundWallet) {
          logError(`Receiver owner is ${owner}, expected ${refundWallet}`)
        } else {
          consola.success('Receiver owner is correct')
        }
      }

      // ServiceFeeCollector
      if (deployedContracts['ServiceFeeCollector']) {
        contractAddress = deployedContracts['ServiceFeeCollector']
        owner = await getOwnablContract(
          contractAddress,
          publicClient
        ).read.owner()
        if (owner !== withdrawWallet) {
          logError(
            `ServiceFeeCollector owner is ${owner}, expected ${withdrawWallet}`
          )
        } else {
          consola.success('ServiceFeeCollector owner is correct')
        }
      }

      // Check access permissions
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

      finish()
    }
  },
})

const logError = (string: string) => {
  consola.error(string)
  errors.push(string)
}

const getOwnablContract = (address: Address, client: PublicClient) => {
  return getContract({
    address,
    abi: parseAbi(['function owner() external view returns (address)']),
    client,
  })
}

const finish = () => {
  if (errors.length) {
    consola.error(`${errors.length} Errors found in deployment`)
  } else {
    consola.success('Deployment checks passed')
  }
}

runMain(main)
