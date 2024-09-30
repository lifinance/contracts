import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { PeripheryRegistryFacet } from '../../../typechain'
import {
  diamondContractName,
  updateDeploymentLogs,
  verifyContract,
} from './9999_utils'
import globalConfig from '../../../config/tokenwrapper.json'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const WRAPPED_NATIVE_ADDRESS = globalConfig[network.name]

  const diamond = await ethers.getContract(diamondContractName)

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  const deployedTokenWrapper = await deploy('TokenWrapper', {
    from: deployer,
    args: [WRAPPED_NATIVE_ADDRESS],
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const TokenWrapper = await ethers.getContract('TokenWrapper')
  const TokenWrapperAddr = await registryFacet.getPeripheryContract(
    'TokenWrapper'
  )

  if (TokenWrapperAddr !== TokenWrapper.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract(
      'TokenWrapper',
      TokenWrapper.address
    )
    console.log('Done!')
  }

  const isVerified = await verifyContract(hre, 'TokenWrapper', {
    address: TokenWrapper.address,
    args: [WRAPPED_NATIVE_ADDRESS],
  })

  await updateDeploymentLogs('TokenWrapper', deployedTokenWrapper, isVerified)
}

export default func

func.id = 'deploy_token_wrapper'
func.tags = ['DeployTokenWrapper']
func.dependencies = ['DeployPeripheryRegistryFacet']
