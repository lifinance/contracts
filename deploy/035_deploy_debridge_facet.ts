import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config from '../config/debridge'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (!config[network.name]) {
    console.log(`No DeBridgeFacet config set for ${network.name}. Skipping...`)
    return
  }

  const GATE_ADDR = config[network.name].deBridgeGate

  await deploy('DeBridgeFacet', {
    from: deployer,
    log: true,
    args: [GATE_ADDR],
    deterministicDeployment: true,
  })

  const debridgeFacet = await ethers.getContract('DeBridgeFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([debridgeFacet], diamond.address)

  await verifyContract(hre, 'DeBridgeFacet', {
    address: debridgeFacet.address,
    args: [GATE_ADDR],
  })
}

export default func
func.id = 'deploy_debridge_facet'
func.tags = ['DeployDeBridgeFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
