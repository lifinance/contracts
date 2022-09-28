import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/arbitrum'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(
      `No ArbitrumBridgeFacet config set for ${network.name}. Skipping...`
    )
    return
  }

  const ROUTER_ADDR = config[network.name].gatewayRouter
  const INBOX_ADDR = config[network.name].inbox

  await deploy('ArbitrumBridgeFacet', {
    from: deployer,
    log: true,
    args: [ROUTER_ADDR, INBOX_ADDR],
    deterministicDeployment: true,
  })

  const arbitrumBridgeFacet = await ethers.getContract('ArbitrumBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([arbitrumBridgeFacet], diamond.address)

  await verifyContract(hre, 'ArbitrumBridgeFacet', {
    address: arbitrumBridgeFacet.address,
    args: [ROUTER_ADDR, INBOX_ADDR],
  })
}

export default func
func.id = 'deploy_arbitrum_bridge_facet'
func.tags = ['DeployArbitrumBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
