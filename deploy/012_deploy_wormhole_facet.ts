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

  await deploy('WormholeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const wormholeFacet = await ethers.getContract('WormholeFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([wormholeFacet], diamond.address)

  await verifyContract(hre, 'WormholeFacet', { address: wormholeFacet.address })
}

export default func
func.id = 'deploy_wormhole_facet'
func.tags = ['DeployWormholeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
