import { utils } from 'ethers'
import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/nxtp'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  if (config[network.name] === undefined) {
    console.info('Not deploying NXTPFacet because txManagerAddress is not set')
    return
  }

  const TX_MGR_ADDR = config[network.name].txManagerAddress

  await deploy('NXTPFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const nxtpFacet = await ethers.getContract('NXTPFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([nxtpFacet], diamond.address)

  await verifyContract(hre, 'NXTPFacet', { address: nxtpFacet.address })
}
export default func
func.id = 'deploy_NXTP_facet'
func.tags = ['DeployNXTPFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
