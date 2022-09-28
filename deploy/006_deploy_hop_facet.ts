import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import { utils } from 'ethers'
import config from '../config/hop'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No HopFacet config set for ${network.name}. Skipping...`)
    return
  }

  await deploy('HopFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const ABI = ['function initHop(tuple(address assetId,address bridge)[])']
  const iface = new utils.Interface(ABI)

  const bridges = Object.values(config[network.name].tokens).map((value) => ({
    assetId: value.token,
    bridge: config[network.name].chainId == 1 ? value.bridge : value.ammWrapper,
  }))

  const initData = iface.encodeFunctionData('initHop', [bridges])

  const hopFacet = await ethers.getContract('HopFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets(
    [hopFacet],
    diamond.address,
    hopFacet.address,
    initData
  )
  await verifyContract(hre, 'HopFacet', {
    address: hopFacet.address,
  })
}
export default func
func.id = 'deploy_hop_facet'
func.tags = ['DeployHopFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
