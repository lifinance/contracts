import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/wormhole'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No WormholeFacet config set for ${network.name}. Skipping...`)
    return
  }

  const ROUTER_ADDR = config[network.name].wormholeRouter

  await deploy('WormholeFacet', {
    from: deployer,
    log: true,
    args: [ROUTER_ADDR],
    deterministicDeployment: true,
  })

  const wormholeFacet = await ethers.getContract('WormholeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([wormholeFacet], diamond.address)

  await verifyContract(hre, 'WormholeFacet', {
    address: wormholeFacet.address,
    args: [ROUTER_ADDR],
  })
}

export default func
func.id = 'deploy_wormhole_facet'
func.tags = ['DeployWormholeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
