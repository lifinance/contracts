import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { diamondContractName, deployFacet } from './9999_utils'
import config from '../config/gaszip.json'

interface GasZipConfig {
  gasZipRouters: {
    [network: string]: string
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!(config as GasZipConfig).gasZipRouters[network.name]) {
    console.log(`No Across config set for ${network.name}. Skipping...`)
    return
  }

  const ROUTER = (config as GasZipConfig).gasZipRouters[network.name]

  await deployFacet(hre, 'GasZipFacet', { args: [ROUTER] })
}

export default func

func.id = 'deploy_gaszip_facet'
func.tags = ['DeployGasZipFacet']
func.dependencies = [
  // 'InitialFacets',
  // diamondContractName,
  // 'InitFacets',
  // 'DeployDexManagerFacet',
]
