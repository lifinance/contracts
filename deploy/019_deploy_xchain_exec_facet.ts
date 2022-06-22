import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  await deploy('XChainExecFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const xChainExecFacet = await ethers.getContract('XChainExecFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([xChainExecFacet], diamond.address)
}
export default func
func.id = 'deploy_xchain_exec_facet'
func.tags = ['DeployXChainExecFacet']
