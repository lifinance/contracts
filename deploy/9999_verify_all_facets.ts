import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network, getNamedAccounts } from 'hardhat'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

export const verifyContract = async function (
  hre: HardhatRuntimeEnvironment,
  name: string,
  options?: { address?: string; args?: any[] }
) {
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  try {
    await hre.run('verify:verify', {
      address: options?.address || (await ethers.getContract(name)).address,
      constructorArguments: options?.args || [],
    })
  } catch (e) {
    console.log(`Failed to verify ${name} contract: ${e}`)
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (network.name === 'hardhat') return

  const { deployer } = await getNamedAccounts()

  await verifyContract(hre, 'LiFiDiamond', {
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
