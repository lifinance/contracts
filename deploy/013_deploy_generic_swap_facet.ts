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

  const deployedFacet = await deploy('GenericSwapFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const swapFacet = await ethers.getContract('GenericSwapFacet')
  const diamond = await ethers.getContract(diamondContractName)

  await addOrReplaceFacets([swapFacet], diamond.address)

  const isVerified = await verifyContract(hre, 'GenericSwapFacet', {
    address: swapFacet.address,
  })

  await updateDeploymentLogs('GenericSwapFacet', deployedFacet, isVerified)
}

export default func

func.id = 'deploy_generic_swap_facet'
func.tags = ['DeployGenericSwapFacet']
func.dependencies = ['InitialFacets', diamondContractName, 'InitFacets']
