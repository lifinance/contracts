import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network, getNamedAccounts } from 'hardhat'
import { diamondContractName, verifyContract } from './9999_utils'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (network.name === 'hardhat') return

  const { deployer } = await getNamedAccounts()

  await verifyContract(hre, diamondContractName, {
    args: [deployer, (await ethers.getContract('DiamondCutFacet')).address],
  })

  await verifyContract(hre, 'DiamondLoupeFacet')
  await verifyContract(hre, 'DiamondCutFacet')
  await verifyContract(hre, 'OwnershipFacet')

  await verifyContract(hre, 'PeripheryRegistryFacet')
  await verifyContract(hre, 'Executor')
  await verifyContract(hre, 'Receiver')
}
export default func
func.id = 'verify_all_facets'
func.tags = ['VerifyAllFacets']
