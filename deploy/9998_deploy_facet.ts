import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { ethers, network } from 'hardhat'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'

export const deployFacet = async function (
  hre: HardhatRuntimeEnvironment,
  name: string,
  options?: { address?: string; args?: any[] }
) {
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  await deploy(name, {
    from: deployer,
    log: true,
    args: options?.args,
    skipIfAlreadyDeployed: true,
  })

  const facet = await ethers.getContract(name)
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([facet], diamond.address)

  await verifyContract(hre, name, {
    address: facet.address,
    args: options?.args,
  })
}
