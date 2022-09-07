import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import config from '../config/axelar'
import sgConfig from '../config/stargate'
import { Executor, ERC20Proxy, PeripheryRegistryFacet } from '../typechain'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  let gateway = ethers.constants.AddressZero
  let sgRouter = ethers.constants.AddressZero
  if (config[network.name]) {
    gateway = config[network.name].gateway
  }
  if (sgConfig[network.name]) {
    sgRouter = sgConfig[network.name].stargateRouter
  }

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('ERC20Proxy', {
    from: deployer,
    log: true,
    args: [deployer],
    deterministicDeployment: true,
  })

  const erc20Proxy: ERC20Proxy = await ethers.getContract('ERC20Proxy')

  const erc20ProxyAddr = await registryFacet.getPeripheryContract('ERC20Proxy')

  if (erc20ProxyAddr !== erc20Proxy.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract(
      'ERC20Proxy',
      erc20Proxy.address
    )
    console.log('Done!')
  }

  await deploy('Executor', {
    from: deployer,
    log: true,
    args: [deployer, gateway, sgRouter, erc20Proxy.address],
    deterministicDeployment: true,
  })

  const executor: Executor = await ethers.getContract('Executor')

  const executorAddr = await registryFacet.getPeripheryContract('Executor')

  if (executorAddr !== executor.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract('Executor', executor.address)
    console.log('Done!')
  }

  await erc20Proxy.setAuthorizedCaller(executor.address, true)

  try {
    await hre.run('verify:verify', {
      address: executor.address,
      constructorArguments: [deployer, gateway, sgRouter, erc20Proxy.address],
    })
  } catch (e) {
    console.log(`Failed to verify contract: ${e}`)
  }
}

export default func
func.id = 'deploy_executor'
func.tags = ['DeployExecutor']
func.dependencies = ['DeployPeripheryRegistryFacet']
