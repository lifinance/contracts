import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { diamondContractName, deployFacet } from './9999_utils'
import config from '../config/across.json'

interface AcrossConfig {
  [network: string]: {
    acrossSpokePool?: string
    weth?: string
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!(config as AcrossConfig)[network.name]) {
    console.log(`No Across config set for ${network.name}. Skipping...`)
    return
  }

  const SPOKE_POOL = (config as AcrossConfig)[network.name].acrossSpokePool
  const WETH = (config as AcrossConfig)[network.name].weth
  const { deployer } = await hre.getNamedAccounts()

  await deployFacet(hre, 'AcrossFacetPacked', {
    args: [SPOKE_POOL, WETH, deployer],
  })
}

export default func

func.id = 'deploy_across_facet_packed'
func.tags = ['DeployAcrossFacetPacked']
func.dependencies = [
  'InitialFacets',
  diamondContractName,
  'InitFacets',
  'DeployDexManagerFacet',
]
