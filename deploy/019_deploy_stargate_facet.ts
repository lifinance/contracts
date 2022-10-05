import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import { utils } from 'ethers'
import config, { POOLS } from '../config/stargate'

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

  const ABI = [
    'function initStargate(tuple(address token,uint16 poolId)[],tuple(uint256 chainId,uint16 layerZeroChainId)[])',
  ]
  const iface = new utils.Interface(ABI)

  const chainIdConfig = Object.values(config).map((_config) => ({
    chainId: _config.chainId,
    layerZeroChainId: _config.layerZeroChainId,
  }))

  const poolIdConfig = Object.values(POOLS)
    .filter((pool: any) => pool[network.name])
    .map((pool: any) => ({
      token: pool[network.name],
      poolId: pool.id,
    }))

  const initData = iface.encodeFunctionData('initStargate', [
    poolIdConfig,
    chainIdConfig,
  ])

  const stargetFacet = await ethers.getContract('StargateFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets(
    [stargetFacet],
    diamond.address,
    stargetFacet.address,
    initData
  )

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
