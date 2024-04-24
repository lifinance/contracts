import { consola } from 'consola'
import { $, spinner } from 'zx'

const network = 'mainnet'
const louperCmd = 'louper-cli'

const errors: string[] = []
const main = async () => {
  consola.info('Running post deployment checks...\n')

  // Check core facets
  consola.box('Checking Core Facets...')
  const coreFacets = [
    'DiamondCutFacet',
    'DiamondLoupeFacet',
    'OwnershipFacet',
    'WithdrawFacet',
    'DexManagerFacet',
    'PeripheryRegistryFacet',
    'AccessManagerFacet',
  ]
  const deployedContracts = await import(`../../deployments/${network}.json`)
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

  consola.box('Checking facets registered in diamond...')
  // Check that core facets are registered
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
}

const logError = (string: string) => {
  consola.error(string)
  errors.push(string)
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

main()
