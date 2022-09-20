import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/cbridge2'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No CBridgeFacet config set for ${network.name}. Skipping...`)
    return
  }

  const CBRIDGE_ADDR = config[network.name].cBridge

  await deploy('CBridgeFacet', {
    from: deployer,
    log: true,
    args: [CBRIDGE_ADDR],
    deterministicDeployment: true,
  })

  const cBridgeFacet = await ethers.getContract('CBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([cBridgeFacet], diamond.address)

  await verifyContract(hre, 'CBridgeFacet', {
    address: cBridgeFacet.address,
    args: [CBRIDGE_ADDR],
  })
}
export default func
func.id = 'deploy_c_bridge_facet'
func.tags = ['DeployCBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
