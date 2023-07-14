import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { deployFacet } from './9998_deploy_facet'
import config from '../config/cbridge.json'

interface CBridgeConfig {
  [network: string]: {
    cBridge?: string
    cfUSDC?: string
    messageBuss?: string
    tokenstoApprove?: string[]
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!(config as CBridgeConfig)[network.name]) {
    console.log(`No cBridge config set for ${network.name}. Skipping...`)
    return
  }

  const CBRIDGE = (config as CBridgeConfig)[network.name].cBridge

  await deployFacet(hre, 'CBridgeFacet', { args: [CBRIDGE] })
}

export default func

func.id = 'deploy_cbridge_facet'
func.tags = ['DeployCBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
