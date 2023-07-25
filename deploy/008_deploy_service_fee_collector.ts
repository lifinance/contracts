import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { PeripheryRegistryFacet } from '../typechain'
import {
  diamondContractName,
  updateDeploymentLogs,
  verifyContract,
} from './9999_utils'
import globalConfig from '../config/global.json'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const WITHDRAW_WALLET_ADDR = globalConfig.withdrawWallet

  const diamond = await ethers.getContract(diamondContractName)

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  const deployedServiceFeeCollector = await deploy('ServiceFeeCollector', {
    from: deployer,
    args: [WITHDRAW_WALLET_ADDR],
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const serviceFeeCollector = await ethers.getContract('ServiceFeeCollector')
  const serviceFeeCollectorAddr = await registryFacet.getPeripheryContract(
    'ServiceFeeCollector'
  )

  if (serviceFeeCollectorAddr !== serviceFeeCollector.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract(
      'ServiceFeeCollector',
      serviceFeeCollector.address
    )
    console.log('Done!')
  }

  const isVerified = await verifyContract(hre, 'ServiceFeeCollector', {
    address: serviceFeeCollector.address,
    args: [WITHDRAW_WALLET_ADDR],
  })

  await updateDeploymentLogs(
    'ServiceFeeCollector',
    deployedServiceFeeCollector,
    isVerified
  )
}

export default func

func.id = 'deploy_service_fee_collector'
func.tags = ['DeployServiceFeeCollector']
func.dependencies = ['DeployPeripheryRegistryFacet']
