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

  const deployedFacet = await deploy('StandardizedCallFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const accessManagerFacet = await ethers.getContract('StandardizedCallFacet')
  const diamond = await ethers.getContract(diamondContractName)

  await addOrReplaceFacets([accessManagerFacet], diamond.address)

  const isVerified = await verifyContract(hre, 'StandardizedCallFacet', {
    address: accessManagerFacet.address,
  })

  await updateDeploymentLogs('StandardizedCallFacet', deployedFacet, isVerified)
}

export default func

func.id = 'deploy_standardized_call_facet'
func.tags = ['DeployStandardizedCallFacet']
