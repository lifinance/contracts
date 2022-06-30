import { utils } from 'ethers'
import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import config from '../config/polygon'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const ROOT_CHAIN_MANAGER_ADDRESS = config[network.name].rootChainManager
  const ERC20_PREDICATE_ADDRESS = config[network.name].erc20Predicate

  await deploy('PolygonBridgeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const polygonBridgeFacet = await ethers.getContract('PolygonBridgeFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  const ABI = ['function initPolygonBridge(address,address)']
  const iface = new utils.Interface(ABI)

  const initData = iface.encodeFunctionData('initPolygonBridge', [
    ROOT_CHAIN_MANAGER_ADDRESS,
    ERC20_PREDICATE_ADDRESS,
  ])

  await addOrReplaceFacets(
    [polygonBridgeFacet],
    diamond.address,
    polygonBridgeFacet.address,
    initData
  )
}

export default func
func.id = 'deploy_polygon_bridge_facet'
func.tags = ['DeployPolygonBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
