import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { utils } from 'ethers'
import config from '../config/gnosisBridge'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`${network.name} is not supported for GnosisBridge`)
    return
  }

  const xDaiBridge = config[network.name].xDaiBridge
  const token = config[network.name].token
  const dstChainId = config[network.name].dstChainId

  await deploy('GnosisBridgeFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const gnosisBridgeFacet = await ethers.getContract('GnosisBridgeFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  const ABI = ['function initGnosisBridge(address,address,uint64)']
  const iface = new utils.Interface(ABI)

  const initData = iface.encodeFunctionData('initGnosisBridge', [
    xDaiBridge,
    token,
    dstChainId,
  ])

  await addOrReplaceFacets(
    [gnosisBridgeFacet],
    diamond.address,
    gnosisBridgeFacet.address,
    initData
  )
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
