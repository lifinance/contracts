import { utils } from 'ethers'
import { ethers } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import { verifyContract } from './9999_verify_all_facets'
import config, { POOLS } from '../config/stargate'
import { StargateFacet } from '../typechain/src/Facets/StargateFacet'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  if (config[network.name] === undefined) {
    console.log('No Stargate config set for network. Skipping...')
    return
  }

  await deploy('StargateFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const stargetFacet = await ethers.getContract('StargateFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([stargetFacet], diamond.address)

  await verifyContract(hre, 'StargateFacet', { address: stargetFacet.address })

  const stargate = <StargateFacet>(
    await ethers.getContractAt('StargateFacet', diamond.address)
  )

  await Promise.all(
    Object.values(config).map(async (_config) => {
      await stargate.setLayerZeroChainId(
        _config.chainId,
        _config.layerZeroChainId,
        { from: deployer }
      )
    })
  )

  await Promise.all(
    Object.values(POOLS).flatMap((pool: any) => {
      const id = pool.id
      return Object.values(pool).map(async (_address: any) => {
        const address = _address.toString()
        if (!address.startsWith('0x')) return
        await stargate.setStargatePoolId(address, id, { from: deployer })
      })
    })
  )
}

export default func
func.id = 'deploy_starget_facet'
func.tags = ['DeployStargateFacet']
func.dependencies = [
  'InitialFacets',
  'LiFiDiamond',
  'InitFacets',
  'DeployDexManagerFacet',
]
