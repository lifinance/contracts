import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { diamondContractName, deployFacet } from './9999_utils'
import config from '../config/across.json'
import globalConfig from '../config/global.json'
import zksyncDeployments from '../deployments/zksync.json'

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
  const REFUND_WALLET = globalConfig.refundWallet
  const EXECUTOR = zksyncDeployments.Executor

  await deployFacet(hre, 'AcrossFacetV3', { args: [SPOKE_POOL, WETH] })
  await deployFacet(hre, 'ReceiverAcrossV3', {
    args: [REFUND_WALLET, EXECUTOR, SPOKE_POOL, 100000],
  })
}

export default func

func.id = 'deploy_across_facet_v3'
func.tags = ['DeployAcrossFacetV3']
func.dependencies = [
  // 'InitialFacets',
  // diamondContractName,
  // 'InitFacets',
  // 'DeployDexManagerFacet',
]
