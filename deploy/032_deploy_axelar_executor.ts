import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import config from '../config/axelar'
import { AxelarExecutor, PeripheryRegistryFacet } from '../typechain'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  let gateway = ethers.constants.AddressZero
  if (config[network.name]) {
    gateway = config[network.name].gateway
  }

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('AxelarExecutor', {
    from: deployer,
    log: true,
    args: [deployer, gateway],
    deterministicDeployment: true,
  })

  const executor: AxelarExecutor = await ethers.getContract('AxelarExecutor')

  const executorAddr = await registryFacet.getPeripheryContract(
    'AxelarExecutor'
  )

  if (executorAddr !== executor.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract(
      'AxelarExecutor',
      executor.address
    )
    console.log('Done!')
  }

  try {
    await hre.run('verify:verify', {
      address: executor.address,
      constructorArguments: [deployer, gateway],
    })
  } catch (e) {
    console.log(`Failed to verify contract: ${e}`)
  }
}

export default func
func.id = 'deploy_axelar_executor'
func.tags = ['DeployAxelarExecutor']
func.dependencies = ['DeployPeripheryRegistryFacet']
