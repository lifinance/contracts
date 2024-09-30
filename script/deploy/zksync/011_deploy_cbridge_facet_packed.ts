import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { diamondContractName, deployFacet } from './9999_utils'
import config from '../../../config/cbridge.json'

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
  const { deployer } = await hre.getNamedAccounts()

  await deployFacet(hre, 'CBridgeFacetPacked', { args: [CBRIDGE, deployer] })
}

export default func

func.id = 'deploy_cbridge_facet_packed'
func.tags = ['DeployCBridgeFacetPacked']
func.dependencies = [
  'InitialFacets',
  diamondContractName,
  'InitFacets',
  'DeployDexManagerFacet',
]
