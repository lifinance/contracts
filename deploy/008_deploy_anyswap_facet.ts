import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre
  const { deploy } = deployments
  const alice = await ethers.getSigners()
  const deployer = alice[0].address
  //const { deployer } = await getNamedAccounts()

  if (network.name == 'hardhat' || network.name == 'rinkeby') {
    await deploy('USDT', {
      from: deployer,
      args: [deployer, 'Tether USD', 'USDT'],
      log: true,
      deterministicDeployment: true,
    })
    const usdt = await ethers.getContract('USDT')
    await deploy('AnyswapV5ERC20', {
      from: deployer,
      args: ['anyToken', 'anyT', '18', usdt.address, deployer],
      log: true,
      deterministicDeployment: true,
    })
    await deploy('AnyswapV5Router', {
      from: deployer,
      args: [
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000',
      ],
      log: true,
      deterministicDeployment: true,
    })
  }

  await deploy('AnyswapFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const anyswapFacet = await ethers.getContract('AnyswapFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([anyswapFacet], diamond.address)
}

export default func
func.id = 'deploy_anyswap_facet'
func.tags = ['DeployAnyswapFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
