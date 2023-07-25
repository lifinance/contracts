import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { Receiver, PeripheryRegistryFacet } from '../typechain'
import {
  diamondContractName,
  updateDeploymentLogs,
  verifyContract,
} from './9999_utils'
import globalConfig from '../config/global.json'
import stargateConfig from '../config/stargate.json'
import amarokConfig from '../config/amarok.json'

interface StargateConfig {
  routers: { [network: string]: string }
  chains: Array<{
    chainId: number
    lzChainId: number
  }>
}

interface AmarokConfig {
  [network: string]: {
    connextHandler: string
    domain: string
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const REFUND_WALLET = globalConfig.refundWallet
  const STARGATE_ROUTER =
    (stargateConfig as StargateConfig).routers[network.name] ||
    ethers.constants.AddressZero
  const AMAROK_ROUTER =
    (amarokConfig as AmarokConfig)[network.name]?.connextHandler ||
    ethers.constants.AddressZero

  const diamond = await ethers.getContract(diamondContractName)

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )
  const executorAddr = await registryFacet.getPeripheryContract('Executor')

  const deployedReceiver = await deploy('Receiver', {
    from: deployer,
    log: true,
    args: [REFUND_WALLET, STARGATE_ROUTER, AMAROK_ROUTER, executorAddr, 100000],
    skipIfAlreadyDeployed: true,
  })

  const receiver: Receiver = await ethers.getContract('Receiver')
  const receiverAddr = await registryFacet.getPeripheryContract('Receiver')

  if (receiverAddr !== receiver.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract('Receiver', receiver.address)
    console.log('Done!')
  }

  const isVerified = await verifyContract(hre, 'Receiver', {
    address: receiver.address,
    args: [REFUND_WALLET, STARGATE_ROUTER, AMAROK_ROUTER, executorAddr, 100000],
  })

  await updateDeploymentLogs('Receiver', deployedReceiver, isVerified)
}

export default func

func.id = 'deploy_receiver'
func.tags = ['DeployReceiver']
func.dependencies = ['DeployPeripheryRegistryFacet']
