import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  await deploy('HopFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const hopFacet = await ethers.getContract('HopFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([hopFacet], diamond.address)
  await verifyContract(hre, 'HopFacet', { address: hopFacet.address })
}
export default func
func.id = 'deploy_hop_facet'
func.tags = ['DeployHopFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
