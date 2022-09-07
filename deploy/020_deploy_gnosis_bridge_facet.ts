import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { utils } from 'ethers'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  if (network.name !== 'mainnet' && network.name !== 'hardhat') {
    console.log(`${network.name} is not supported for GnosisBridge`)
    return
  }

  await deploy('GnosisBridgeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const gnosisBridgeFacet = await ethers.getContract('GnosisBridgeFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([gnosisBridgeFacet], diamond.address)

  await verifyContract(hre, 'GnosisBridgeFacet', {
    address: gnosisBridgeFacet.address,
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
