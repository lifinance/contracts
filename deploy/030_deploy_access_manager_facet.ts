import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  await deploy('AccessManagerFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const accessMgrFacet = await ethers.getContract('AccessManagerFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([accessMgrFacet], diamond.address)

  await verifyContract(hre, 'AccessManagerFacet', {
    address: accessMgrFacet.address,
  })
}
export default func
func.id = 'deploy_access_manager_facet'
func.tags = ['DeployAccessManagerFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
