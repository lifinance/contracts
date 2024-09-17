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

  const LIFUEL_REBALANCE_WALLET_ADDR = globalConfig.lifuelRebalanceWallet

  const diamond = await ethers.getContract(diamondContractName)

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  const deployedLiFuelFeeCollector = await deploy('LiFuelFeeCollector', {
    from: deployer,
    args: [LIFUEL_REBALANCE_WALLET_ADDR],
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const lifuelFeeCollector = await ethers.getContract('LiFuelFeeCollector')
  const lifuelFeeCollectorAddr = await registryFacet.getPeripheryContract(
    'LiFuelFeeCollector'
  )

  if (lifuelFeeCollectorAddr !== lifuelFeeCollector.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract(
      'LiFuelFeeCollector',
      lifuelFeeCollector.address
    )
    console.log('Done!')
  }

  const isVerified = await verifyContract(hre, 'LiFuelFeeCollector', {
    address: lifuelFeeCollector.address,
    args: [LIFUEL_REBALANCE_WALLET_ADDR],
  })

  await updateDeploymentLogs(
    'LiFuelFeeCollector',
    deployedLiFuelFeeCollector,
    isVerified
  )
}

export default func

func.id = 'deploy_lifuel_fee_collector'
func.tags = ['DeployLiFuelFeeCollector']
// func.dependencies = ['DeployPeripheryRegistryFacet']
