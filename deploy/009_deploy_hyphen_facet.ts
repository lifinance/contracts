import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/hyphen'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No HyphenFacet config set for ${network.name}. Skipping...`)
    return
  }

  const ROUTER_ADDR = config[network.name].hyphenRouter

  await deploy('HyphenFacet', {
    from: deployer,
    log: true,
    args: [ROUTER_ADDR],
    deterministicDeployment: true,
  })

  const hyphenFacet = await ethers.getContract('HyphenFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([hyphenFacet], diamond.address)

  await verifyContract(hre, 'HyphenFacet', {
    address: hyphenFacet.address,
    args: [ROUTER_ADDR],
  })
}

export default func
func.id = 'deploy_hyphen_facet'
func.tags = ['DeployHyphenFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
