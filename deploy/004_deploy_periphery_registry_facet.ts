import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { addOrReplaceFacets } from '../utils/diamond'
import {
  diamondContractName,
  updateDeploymentLogs,
  verifyContract,
} from './9999_utils'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const deployedFacet = await deploy('PeripheryRegistryFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const registryFacet = await ethers.getContract('PeripheryRegistryFacet')
  const diamond = await ethers.getContract(diamondContractName)

  await addOrReplaceFacets([registryFacet], diamond.address)

  const isVerified = await verifyContract(hre, 'PeripheryRegistryFacet', {
    address: registryFacet.address,
  })

  await updateDeploymentLogs(
    'PeripheryRegistryFacet',
    deployedFacet,
    isVerified
  )
}

export default func

func.id = 'deploy_periphery_registry_facet'
func.tags = ['DeployPeripheryRegistryFacet']
func.dependencies = ['InitialFacets', diamondContractName, 'InitFacets']
