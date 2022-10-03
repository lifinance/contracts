import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { network, ethers } from 'hardhat'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'hardhat' && process.env.REDEPLOY !== 'true') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  const diamondCutFacet = await ethers.getContract('DiamondCutFacet')

  const lifiDiamond = await deploy('LiFiDiamond', {
    from: deployer,
    args: [deployer, diamondCutFacet.address],
    log: true,
    deterministicDeployment: true,
  })

  await verifyContract(hre, 'LiFiDiamond', {
    address: lifiDiamond.address,
    args: [deployer, diamondCutFacet.address],
  })
}
export default func
func.id = 'deploy_lifi_diamond'
func.tags = ['LiFiDiamond']
