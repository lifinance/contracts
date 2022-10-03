import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import { utils } from 'ethers'
import config from '../config/multichain'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No AnyswapFacet config set for ${network.name}. Skipping...`)
    return
  }

  await deploy('MultichainFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const ABI = ['function initMultichain(address[] routers)']
  const iface = new utils.Interface(ABI)

  const routers = config[network.name]

  const initData = iface.encodeFunctionData('initMultichain', [routers])

  const multichainFacet = await ethers.getContract('MultichainFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets(
    [multichainFacet],
    diamond.address,
    multichainFacet.address,
    initData
  )

  await verifyContract(hre, 'MultichainFacet', {
    address: multichainFacet.address,
  })
}

export default func
func.id = 'deploy_multichain_facet'
func.tags = ['DeployMultichainFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
