import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/axelar'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No AxelarFacet config set for ${network.name}. Skipping...`)
    return
  }

  const GATEWAY_ADDR = config[network.name].gateway
  const GAS_SERVICE_ADDR = config[network.name].gasService

  await deploy('AxelarFacet', {
    from: deployer,
    log: true,
    args: [GATEWAY_ADDR, GAS_SERVICE_ADDR],
    deterministicDeployment: true,
  })

  const axelarFacet = await ethers.getContract('AxelarFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([axelarFacet], diamond.address)

  await verifyContract(hre, 'AxelarFacet', {
    address: axelarFacet.address,
    args: [GATEWAY_ADDR, GAS_SERVICE_ADDR],
  })
}

export default func
func.id = 'deploy_axelar_facet'
func.tags = ['DeployAxelarFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
