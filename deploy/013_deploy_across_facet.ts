import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { utils } from 'ethers'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/across'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (config[network.name] === undefined) {
    console.info('Not deploying AcrossFacet because acrossSpokePool is not set')
    return
  }

  const spokePool = config[network.name].acrossSpokePool
  const weth = config[network.name].weth

  await deploy('AcrossFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const acrossFacet = await ethers.getContract('AcrossFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([acrossFacet], diamond.address)

  await verifyContract(hre, 'AcrossFacet', { address: acrossFacet.address })
}

export default func
func.id = 'deploy_across_facet'
func.tags = ['DeployAcrossFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
