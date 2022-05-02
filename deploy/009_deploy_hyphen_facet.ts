import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { utils } from 'ethers'
import config from '../config/hyphen'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const hyphenRouter = config[network.name].hyphenRouter

  await deploy('HyphenFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const hyphenFacet = await ethers.getContract('HyphenFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  const ABI = ['function initHyphen(address)']
  const iface = new utils.Interface(ABI)

  const initData = iface.encodeFunctionData('initHyphen', [hyphenRouter])

  await addOrReplaceFacets(
    [hyphenFacet],
    diamond.address,
    hyphenFacet.address,
    initData
  )
}

export default func
func.id = 'deploy_hyphen_facet'
func.tags = ['DeployHyphenFacet']
func.dependencies = ['InitFacets', 'DeployDexManagerFacet']
