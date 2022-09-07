import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { PeripheryRegistryFacet } from '../typechain'
import { verifyContract } from './9999_verify_all_facets'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('FeeCollector', {
    from: deployer,
    args: [deployer],
    log: true,
    deterministicDeployment: true,
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
    args: [deployer],
  })
}
export default func
func.id = 'deploy_fee_collector'
func.tags = ['DeployFeeCollector']
func.dependencies = ['DeployPeripheryRegistryFacet']
