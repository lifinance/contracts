import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { PeripheryRegistryFacet, FusePoolZap } from '../typechain'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  const diamond = await ethers.getContract('LiFiDiamond')

  const registryFacet = <PeripheryRegistryFacet>(
    await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
  )

  await deploy('FusePoolZap', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const zap: FusePoolZap = await ethers.getContract('FusePoolZap')

  const zapAddr = await registryFacet.getPeripheryContract('FusePoolZap')

  if (zapAddr !== zap.address) {
    console.log('Updating periphery registry...')
    await registryFacet.registerPeripheryContract('FuzePoolZap', zap.address)
    console.log('Done!')
  }

  try {
    await hre.run('verify:verify', {
      address: zap.address,
    })
  } catch (e) {
    console.log(`Failed to verify contract: ${e}`)
  }
}

export default func
func.id = 'deploy_fuse_pool_zap'
func.tags = ['DeployFusePoolZap']
func.dependencies = ['DeployPeripheryRegistryFacet']
