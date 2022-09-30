import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/across'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No AcrossFacet config set for ${network.name}. Skipping...`)
    return
  }

  const POOL_ADDR = config[network.name].acrossSpokePool

  await deploy('AcrossFacet', {
    from: deployer,
    log: true,
    args: [POOL_ADDR, config[network.name].weth, 600], // 600 seconds being 10 minutes
    deterministicDeployment: true,
  })

  const ABI = ['function initAcross(uint256)']
  const iface = new ethers.utils.Interface(ABI)

  const acrossFacet = await ethers.getContract('AcrossFacet')
  const diamond = await ethers.getContract('LiFiDiamond')
  const initData = iface.encodeFunctionData('initHop', [10 * 60])

  await addOrReplaceFacets(
    [acrossFacet],
    diamond.address,
    acrossFacet.address,
    initData
  )

  await verifyContract(hre, 'AcrossFacet', {
    address: acrossFacet.address,
    args: [POOL_ADDR, config[network.name].weth, 600], // 600 seconds being 10 minutes
  })
}

export default func
func.id = 'deploy_across_facet'
func.tags = ['DeployAcrossFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
