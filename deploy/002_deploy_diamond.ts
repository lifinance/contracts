import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network } from 'hardhat'
import { diamondContractName, verifyContract } from './9999_utils'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts, ethers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const diamondCutFacet = await ethers.getContract('DiamondCutFacet')

  const lifiDiamond = await deploy(diamondContractName, {
    from: deployer,
    args: [deployer, diamondCutFacet.address],
    log: true,
    skipIfAlreadyDeployed: true,
  })

  await verifyContract(hre, diamondContractName, {
    address: lifiDiamond.address,
    args: [deployer, diamondCutFacet.address],
  })
}
export default func

func.id = 'deploy_lifi_diamond'
func.tags = [diamondContractName]
