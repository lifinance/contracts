import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/gnosis'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(
      `No GnosisBridgeFacet config set for ${network.name}. Skipping...`
    )
    return
  }

  const XDAI_BRIDGE_ADDR = config[network.name].xDaiBridge

  await deploy('GnosisBridgeFacet', {
    from: deployer,
    log: true,
    args: [XDAI_BRIDGE_ADDR],
    deterministicDeployment: true,
  })

  const gnosisBridgeFacet = await ethers.getContract('GnosisBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([gnosisBridgeFacet], diamond.address)

  await verifyContract(hre, 'GnosisBridgeFacet', {
    address: gnosisBridgeFacet.address,
    args: [XDAI_BRIDGE_ADDR],
  })
}

export default func
func.id = 'deploy_gnosis_bridge_facet'
func.tags = ['DeployGnosisBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
