import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/amarok'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No AmarokFacet config set for ${network.name}. Skipping...`)
    return
  }

  const CONNEXT_HANDLER_ADDR = config[network.name].connextHandler
  const DOMAIN = config[network.name]?.domain

  await deploy('AmarokFacet', {
    from: deployer,
    log: true,
    args: [CONNEXT_HANDLER_ADDR, DOMAIN],
    deterministicDeployment: true,
  })

  let amarokFacet = await ethers.getContract('AmarokFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([amarokFacet], diamond.address)

  amarokFacet = await ethers.getContractAt('AmarokFacet', diamond.address)

  await Promise.all(
    Object.values(config).map(async (_config) => {
      await amarokFacet.setAmarokDomain(_config.chainId, _config.domain, {
        from: deployer,
      })
    })
  )

  await verifyContract(hre, 'AmarokFacet', {
    address: amarokFacet.address,
    args: [CONNEXT_HANDLER_ADDR, DOMAIN],
  })
}

export default func
func.id = 'deploy_amarok_facet'
func.tags = ['DeployAmarokFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
