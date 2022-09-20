import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/anyswap'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No AnyswapFacet config set for ${network.name}. Skipping...`)
    return
  }

  const anyswapRouter = config[network.name].anyswapRouter

  await deploy('AnyswapFacet', {
    from: deployer,
    log: true,
    args: [anyswapRouter],
    deterministicDeployment: true,
  })

  const anyswapFacet = await ethers.getContract('AnyswapFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([anyswapFacet], diamond.address)

  await verifyContract(hre, 'AnyswapFacet', {
    address: anyswapFacet.address,
    args: [anyswapRouter],
  })
}

export default func
func.id = 'deploy_anyswap_facet'
func.tags = ['DeployAnyswapFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
