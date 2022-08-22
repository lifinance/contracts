import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  await deploy('WithdrawFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const withdrawFacet = await ethers.getContract('WithdrawFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([withdrawFacet], diamond.address)

  await verifyContract(hre, 'WithdrawFacet', { address: withdrawFacet.address })
}
export default func
func.id = 'deploy_withdraw_facet'
func.tags = ['DeployWithdrawFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
