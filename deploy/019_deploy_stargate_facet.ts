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

  if (!config[network.name]) {
    console.log(`No StargateFacet config set for ${network.name}. Skipping...`)
    return
  }

  const ROUTER_ADDR = config[network.name].stargateRouter

  await deploy('StargateFacet', {
    from: deployer,
    log: true,
    args: [ROUTER_ADDR],
    deterministicDeployment: true,
  })

  const stargetFacet = await ethers.getContract('StargateFacet')
  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([stargetFacet], diamond.address)

  const stargate = <StargateFacet>(
    await ethers.getContractAt('StargateFacet', diamond.address)
  )

  let tx
  let i = 1
  let configs = Object.values(config)
  for (let _config of configs) {
    console.log(`Mapping ${i} of ${configs.length}...`)
    tx = await stargate.setLayerZeroChainId(
      _config.chainId,
      _config.layerZeroChainId,
      {
        from: deployer,
      }
    )
    await tx.wait()
    i++
  }

  i = 1
  let pools = Object.values(POOLS).filter((pool: any) => pool[network.name])
  for (let pool of pools) {
    console.log(`Setting pool ${i} of ${pools.length}...`)
    tx = await stargate.setStargatePoolId(pool[network.name], pool.id, {
      from: deployer,
    })
    await tx.wait()
    i++
  }

  await verifyContract(hre, 'StargateFacet', {
    address: stargetFacet.address,
    args: [ROUTER_ADDR],
  })
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
