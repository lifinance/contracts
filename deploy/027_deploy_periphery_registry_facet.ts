import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets.ts'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  await deploy('PeripheryRegistryFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const registryFacet = await ethers.getContract('PeripheryRegistryFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([registryFacet], diamond.address)

  await verifyContract(hre, 'PeripheryRegistryFacet', {
    address: registryFacet.address,
  })
}

export default func
func.id = 'deploy_periphery_registry_facet'
func.tags = ['DeployPeripheryRegistryFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
