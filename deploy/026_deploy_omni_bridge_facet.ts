import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/omni'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(
      `No OmniBridgeFacet config set for ${network.name}. Skipping...`
    )
    return
  }

  const FOREIGN_OMNI_BRIDGE_ADDR = config[network.name].foreignOmniBridge
  const WETH_OMNI_BRIDGE_ADDR = config[network.name].wethOmniBridge

  await deploy('OmniBridgeFacet', {
    from: deployer,
    log: true,
    args: [FOREIGN_OMNI_BRIDGE_ADDR, WETH_OMNI_BRIDGE_ADDR],
    deterministicDeployment: true,
  })

  const omniBridgeFacet = await ethers.getContract('OmniBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([omniBridgeFacet], diamond.address)

  await verifyContract(hre, 'OmniBridgeFacet', {
    address: omniBridgeFacet.address,
    args: [FOREIGN_OMNI_BRIDGE_ADDR, WETH_OMNI_BRIDGE_ADDR],
  })
}

export default func
func.id = 'deploy_omni_bridge_facet'
func.tags = ['DeployOmniBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
