import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import sgConfig from '../config/stargate'
import { Receiver, PeripheryRegistryFacet } from '../typechain'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  let sgRouter = ethers.constants.AddressZero
  if (sgConfig[network.name]) {
    sgRouter = sgConfig[network.name].stargateRouter
  }

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )
  const executorAddr = await registryFacet.getPeripheryContract('Executor')

  await deploy('Receiver', {
    from: deployer,
    log: true,
    args: [deployer, sgRouter, executorAddr],
    deterministicDeployment: true,
  })

  const receiver: Receiver = await ethers.getContract('Receiver')
  const receiverAddr = await registryFacet.getPeripheryContract('Receiver')

  if (receiverAddr !== receiver.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract('Receiver', receiver.address)
    console.log('Done!')
  }

  try {
    await hre.run('verify:verify', {
      address: receiver.address,
      constructorArguments: [deployer, sgRouter, diamond.address],
    })
  } catch (e) {
    console.log(`Failed to verify contract: ${e}`)
  }
}

export default func
func.id = 'deploy_receiver'
func.tags = ['DeployReceiver']
func.dependencies = ['DeployPeripheryRegistryFacet']
