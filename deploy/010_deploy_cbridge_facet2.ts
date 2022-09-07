import { utils } from 'ethers'
import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import config from '../config/cbridge2'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()
  let bridgeAddr
  let chainId

  if (config[network.name] === undefined) {
    console.info('Not deploying CBridgeFacet because cBridgeAddr is not set')
    return
  }

  await deploy('CBridgeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const cBridgeFacet = await ethers.getContract('CBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([cBridgeFacet], diamond.address)

  await verifyContract(hre, 'CBridgeFacet', { address: cBridgeFacet.address })
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
