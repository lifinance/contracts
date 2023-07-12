import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { verifyContract } from './9999_verify_all_facets'

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

  await verifyContract(hre, 'DiamondCutFacet', {
    address: diamondCutFacet.address,
  })
  await verifyContract(hre, 'DiamondLoupeFacet', {
    address: diamondLoupeFacet.address,
  })
  await verifyContract(hre, 'OwnershipFacet', {
    address: ownershipFacet.address,
  })
}

export default func

func.id = 'deploy_initial_facets'
func.tags = ['InitialFacets']
