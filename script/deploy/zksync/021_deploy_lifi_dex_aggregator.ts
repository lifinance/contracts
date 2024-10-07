import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { PeripheryRegistryFacet } from '../../../typechain'
import {
  diamondContractName,
  updateDeploymentLogs,
  verifyContract,
} from './9999_utils'
import globalConfig from '../../../config/global.json'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const PAUSER_WALLET = globalConfig.pauserWallet

  const diamond = await ethers.getContract(diamondContractName)

  const constructorArgs = [ethers.constants.AddressZero, [PAUSER_WALLET]]

  const deployedLiFiDEXAggregator = await deploy('LiFiDEXAggregator', {
    from: deployer,
    args: constructorArgs,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const liFiDEXAggregator = await ethers.getContract('LiFiDEXAggregator')
  // SINCE WE ARE CURRENTLY USING A SAFE, THIS CODE WILL NOT WORK - KEEPING IT FOR POTENTIAL FUTURE CHANGES
  // const registryFacet = <PeripheryRegistryFacet>(
  //   await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  // )
  // const liFiDEXAggregatorAddr = await registryFacet.getPeripheryContract(
  //   'LiFiDEXAggregator'
  // )

  // if (liFiDEXAggregatorAddr !== liFiDEXAggregator.address) {
  //   console.log(
  //     `Updating periphery registry on diamond ${diamondContractName}...`
  //   )
  //   await registryFacet.registerPeripheryContract(
  //     'LiFiDEXAggregator',
  //     liFiDEXAggregator.address
  //   )
  //   console.log('Done!')
  // }

  const isVerified = await verifyContract(hre, 'LiFiDEXAggregator', {
    address: liFiDEXAggregator.address,
    args: constructorArgs,
  })

  await updateDeploymentLogs(
    'LiFiDEXAggregator',
    deployedLiFiDEXAggregator,
    isVerified
  )
}

export default func

func.id = 'deploy_lifi_dex_aggregator'
func.tags = ['DeployLiFiDEXAggregator']
func.dependencies = ['DeployPeripheryRegistryFacet']
