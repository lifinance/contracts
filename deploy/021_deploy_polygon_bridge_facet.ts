import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/polygon'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (config[network.name] === undefined) {
    console.log(
      `No PolygonBridgeFacet config set for ${network.name}. Skipping...`
    )
    return
  }

  const ROOT_CHAIN_MGR_ADDR = config[network.name].rootChainManager
  const ERC20_PREDICATE_ADDR = config[network.name].erc20Predicate

  await deploy('PolygonBridgeFacet', {
    from: deployer,
    log: true,
    args: [ROOT_CHAIN_MGR_ADDR, ERC20_PREDICATE_ADDR],
    deterministicDeployment: true,
  })

  const polygonBridgeFacet = await ethers.getContract('PolygonBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([polygonBridgeFacet], diamond.address)

  await verifyContract(hre, 'PolygonBridgeFacet', {
    address: polygonBridgeFacet.address,
    args: [ROOT_CHAIN_MGR_ADDR, ERC20_PREDICATE_ADDR],
  })
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
