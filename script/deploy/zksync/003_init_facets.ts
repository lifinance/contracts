import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { IDiamondLoupe } from '../../../typechain'
import { addFacets, addOrReplaceFacets } from '../../utils/diamond'
import { diamondContractName } from './9999_utils'

const func: DeployFunction = async function () {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const diamondLoupeFacet = await ethers.getContract('DiamondLoupeFacet')
  const ownershipFacet = await ethers.getContract('OwnershipFacet')
  const diamond = await ethers.getContract(diamondContractName)

  const loupe = <IDiamondLoupe>(
    await ethers.getContractAt('IDiamondLoupe', diamond.address)
  )

  try {
    await loupe.facets()
  } catch (e) {
    await addFacets([diamondLoupeFacet], diamond.address)
  }

  await addOrReplaceFacets([diamondLoupeFacet, ownershipFacet], diamond.address)
}

export default func

func.id = 'init_facets'
func.tags = ['InitFacets']
func.dependencies = ['InitialFacets', diamondContractName]
