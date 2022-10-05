import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import { utils } from 'ethers'
import config from '../config/optimism'

interface BridgeConfig {
  assetId: string
  bridge: string
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(
      `No OptimismBridgeFacet config set for ${network.name}. Skipping...`
    )
    return
  }

  await deploy('OptimismBridgeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const ABI = [
    'function initOptimism(tuple(address assetId,address bridge)[],address)',
  ]
  const iface = new utils.Interface(ABI)

  const bridges: BridgeConfig[] = []
  Object.entries(config[network.name].bridges).map(([assetId, bridge]) => {
    if (assetId != 'standardBridge') {
      bridges.push({
        assetId,
        bridge,
      })
    }
  })

  const initData = iface.encodeFunctionData('initOptimism', [
    bridges,
    config[network.name].bridges.standardBridge,
  ])

  const optimismBridgeFacet = await ethers.getContract('OptimismBridgeFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets(
    [optimismBridgeFacet],
    diamond.address,
    optimismBridgeFacet.address,
    initData
  )

  await verifyContract(hre, 'OptimismBridgeFacet', {
    address: optimismBridgeFacet.address,
  })
}

export default func
func.id = 'deploy_optimism_bridge_facet'
func.tags = ['DeployOptimismBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
