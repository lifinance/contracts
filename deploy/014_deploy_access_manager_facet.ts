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

  const deployedFacet = await deploy('AccessManagerFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const accessManagerFacet = await ethers.getContract('AccessManagerFacet')
  const diamond = await ethers.getContract(diamondContractName)

  await addOrReplaceFacets([accessManagerFacet], diamond.address)

  const isVerified = await verifyContract(hre, 'AccessManagerFacet', {
    address: accessManagerFacet.address,
  })

  await updateDeploymentLogs('AccessManagerFacet', deployedFacet, isVerified)
}

export default func

func.id = 'deploy_access_manager_facet'
func.tags = ['DeployAccessManagerFacet']
func.dependencies = ['InitialFacets', diamondContractName, 'InitFacets']
