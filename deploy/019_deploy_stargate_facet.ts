import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/stargate'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No StargateFacet config set for ${network.name}. Skipping...`)
    return
  }

  const ROUTER_ADDR = config[network.name].stargateRouter

  await deploy('StargateFacet', {
    from: deployer,
    log: true,
    args: [ROUTER_ADDR],
    deterministicDeployment: true,
  })

  const stargetFacet = await ethers.getContract('StargateFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([stargetFacet], diamond.address)

  await verifyContract(hre, 'StargateFacet', {
    address: stargetFacet.address,
    args: [ROUTER_ADDR],
  })
}

export default func
func.id = 'deploy_starget_facet'
func.tags = ['DeployStargateFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
