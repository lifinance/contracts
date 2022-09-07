import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { utils } from 'ethers'
import config from '../config/axelar'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`${network.name} is not supported for Axelar`)
    return
  }

  const gateway = config[network.name].gateway
  const gasService = config[network.name].gasService

  if (!gateway || !gasService) {
    console.log(`No config for ${network.name}. Skipping...`)
    return
  }

  await deploy('AxelarFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const axelarFacet = await ethers.getContract('AxelarFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  const ABI = ['function initAxelar(address,address)']
  const iface = new utils.Interface(ABI)

  const initData = iface.encodeFunctionData('initAxelar', [gateway, gasService])

  await addOrReplaceFacets(
    [axelarFacet],
    diamond.address,
    axelarFacet.address,
    initData
  )

  try {
    await hre.run('verify:verify', {
      address: axelarFacet.address,
    })
  } catch (e) {
    console.log(`Failed to verify contract: ${e}`)
  }
}

export default func
func.id = 'deploy_axelar_facet'
func.tags = ['DeployAxelarFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
