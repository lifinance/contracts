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

  const deployedFacet = await deploy('LIFuelFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const facet = await ethers.getContract('LIFuelFacet')
  const diamond = await ethers.getContract(diamondContractName)

  await addOrReplaceFacets([facet], diamond.address)

  const isVerified = await verifyContract(hre, 'LIFuelFacet', {
    address: facet.address,
  })

  await updateDeploymentLogs('LIFuelFacet', deployedFacet, isVerified)
}

export default func

func.id = 'deploy_lifuel_facet'
func.tags = ['DeployLIFuelFacet']
