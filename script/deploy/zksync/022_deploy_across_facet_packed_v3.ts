import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import {
  diamondContractName,
  deployFacet,
  verifyContract,
  updateDeploymentLogs,
} from './9999_utils'
import config from '../../../config/across.json'

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

  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const SPOKE_POOL = String(
    (config as AcrossConfig)[network.name].acrossSpokePool
  )
  const WETH = String((config as AcrossConfig)[network.name].weth)

  if (!SPOKE_POOL || !WETH) {
    console.log(
      `Missing SPOKE_POOL (${SPOKE_POOL}) and/or WETH (${WETH}) address. Skipping...`
    )
    return
  }

  const deployedFacet = await deployFacet(hre, 'AcrossFacetPackedV3', {
    args: [SPOKE_POOL, WETH, String(deployer)],
  })
}

export default func

func.id = 'deploy_across_facet_packed_v3'
func.tags = ['DeployAcrossFacetPackedV3']
func.dependencies = [
  // 'InitialFacets',
  // diamondContractName,
  // 'InitFacets',
  // 'DeployDexManagerFacet',
]
