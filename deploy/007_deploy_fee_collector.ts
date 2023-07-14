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

  const WITHDRAW_WALLET = globalConfig.withdrawWallet

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('FeeCollector', {
    from: deployer,
    args: [WITHDRAW_WALLET],
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const feeCollector = await ethers.getContract('FeeCollector')
  const feeCollectorAddr = await registryFacet.getPeripheryContract(
    'FeeCollector'
  )

  if (feeCollectorAddr !== feeCollector.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract(
      'FeeCollector',
      feeCollector.address
    )
    console.log('Done!')
  }

  await verifyContract(hre, 'FeeCollector', {
    address: feeCollector.address,
    args: [WITHDRAW_WALLET],
  })
}

export default func

func.id = 'deploy_fee_collector'
func.tags = ['DeployFeeCollector']
func.dependencies = ['DeployPeripheryRegistryFacet']
