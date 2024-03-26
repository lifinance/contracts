import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { deployFacet } from './9999_utils'
import config from '../config/symbiosis.json'

interface SymbiosisConfig {
  [network: string]: {
    metaRouter?: string
    gateway?: string
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!(config as SymbiosisConfig)[network.name]) {
    console.log(`No Symbiosis config set for ${network.name}. Skipping...`)
    return
  }

  const META_ROUTER = (config as SymbiosisConfig)[network.name].metaRouter
  const GATEWAY = (config as SymbiosisConfig)[network.name].gateway

  await deployFacet(hre, 'SymbiosisFacet', { args: [META_ROUTER, GATEWAY] })
}

export default func

func.id = 'deploy_symbiosis_facet'
func.tags = ['DeploySymbiosisFacet']
func.dependencies = [
  // 'InitialFacets',
  // diamondContractName,
  // 'InitFacets',
  // 'DeployDexManagerFacet',
]
