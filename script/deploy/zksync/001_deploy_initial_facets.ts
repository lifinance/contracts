import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { updateDeploymentLogs, verifyContract } from './9999_utils'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const diamondCutFacet = await deploy('DiamondCutFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const diamondLoupeFacet = await deploy('DiamondLoupeFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const ownershipFacet = await deploy('OwnershipFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const isDiamondCutFacetVerified = await verifyContract(
    hre,
    'DiamondCutFacet',
    {
      address: diamondCutFacet.address,
    }
  )
  const isDiamondLoupeFacetVerified = await verifyContract(
    hre,
    'DiamondLoupeFacet',
    {
      address: diamondLoupeFacet.address,
    }
  )
  const isOwnershipFacetVerified = await verifyContract(hre, 'OwnershipFacet', {
    address: ownershipFacet.address,
  })

  await updateDeploymentLogs(
    'DiamondCutFacet',
    diamondCutFacet,
    isDiamondCutFacetVerified
  )
  await updateDeploymentLogs(
    'DiamondLoupeFacet',
    diamondLoupeFacet,
    isDiamondLoupeFacetVerified
  )
  await updateDeploymentLogs(
    'OwnershipFacet',
    ownershipFacet,
    isOwnershipFacetVerified
  )
}

export default func

func.id = 'deploy_initial_facets'
func.tags = ['InitialFacets']
