import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { PeripheryRegistryFacet } from '../typechain'
import { verifyContract } from './9999_verify_all_facets'
import globalConfig from '../config/global.json'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const withdrawWalletAddress = globalConfig.withdrawWallet

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('ServiceFeeCollector', {
    from: deployer,
    args: [withdrawWalletAddress],
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

  await verifyContract(hre, 'ServiceFeeCollector', {
    address: serviceFeeCollector.address,
    args: [withdrawWalletAddress],
  })
}
export default func
func.id = 'deploy_service_fee_collector'
func.tags = ['DeployServiceFeeCollector']
func.dependencies = ['DeployPeripheryRegistryFacet']
