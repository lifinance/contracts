import { utils } from 'ethers'
import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import config from '../config/stargate'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const ROUTER_ADDR = config[network.name].stargateRouter

  await deploy('StargateFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const stargetFacet = await ethers.getContract('StargateFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  const ABI = ['function initStargate(address)']
  const iface = new utils.Interface(ABI)

  const initData = iface.encodeFunctionData('initStargate', [ROUTER_ADDR])

  await addOrReplaceFacets(
    [stargetFacet],
    diamond.address,
    stargetFacet.address,
    initData
  )
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
