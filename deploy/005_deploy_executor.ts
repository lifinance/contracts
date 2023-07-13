import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { Executor, ERC20Proxy, PeripheryRegistryFacet } from '../typechain'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('ERC20Proxy', {
    from: deployer,
    log: true,
    args: [deployer],
    skipIfAlreadyDeployed: true,
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
    args: [erc20Proxy.address],
    skipIfAlreadyDeployed: true,
  })

  const executor: Executor = await ethers.getContract('Executor')
  const executorAddr = await registryFacet.getPeripheryContract('Executor')

  if (executorAddr !== executor.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract('Executor', executor.address)
    console.log('Done!')
  }

  await erc20Proxy.setAuthorizedCaller(executor.address, true)

  await verifyContract(hre, 'Executor', {
    address: executor.address,
    args: [erc20Proxy.address],
  })
}

export default func
func.id = 'deploy_executor'
func.tags = ['DeployExecutor']
func.dependencies = ['DeployPeripheryRegistryFacet']
