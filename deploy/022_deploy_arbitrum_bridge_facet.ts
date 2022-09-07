import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (hre.network.name !== 'mainnet' && hre.network.name !== 'hardhat') {
    return
  }

  await deploy('ArbitrumBridgeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const arbitrumBridgeFacet = await ethers.getContract('ArbitrumBridgeFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([arbitrumBridgeFacet], diamond.address)

  await verifyContract(hre, 'ArbitrumBridgeFacet', {
    address: arbitrumBridgeFacet.address,
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
