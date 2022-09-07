import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'

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

  try {
    await hre.run('verify:verify', {
      address: registryFacet.address,
    })
  } catch (e) {
    console.log(`Failed to verify contract: ${e}`)
  }
}

export default func
func.id = 'deploy_periphery_registry_facet'
func.tags = ['DeployPeripheryRegistryFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
