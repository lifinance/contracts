import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import {
  diamondContractName,
  deployFacet,
  verifyContract,
  updateDeploymentLogs,
} from './9999_utils'
import config from '../config/oftwrapper.json'
import { addOrReplaceFacets } from '../utils/diamond'

interface WhitelistConfig {
  address: string
  whitelisted: boolean
}
interface Chain {
  chainId: number
  lzChainId: number
}

interface OFTWrapperConfig {
  chains: Chain[]
  whitelistedOftBridgeContracts: {
    [chain: string]: string[]
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  // extract initialization data from config file
  const chains = (config as OFTWrapperConfig)['chains']
  const whitelist = (config as OFTWrapperConfig)[
    'whitelistedOftBridgeContracts'
  ][network.name]

  // prepare whitelist config (=> add 'true' to every address)
  const whitelistConfig: WhitelistConfig[] = []
  for (let i = 0; i < whitelist.length; i++) {
    whitelistConfig.push({ address: whitelist[i], whitelisted: true })
  }

  // // deploy facet
  // const { deployments, getNamedAccounts } = hre
  // const { deploy } = deployments
  // const { deployer } = await getNamedAccounts()
  //
  // const deployedFacet = await deploy('OFTWrapperFacet', {
  //   from: deployer,
  //   log: true,
  //   args: [],
  //   skipIfAlreadyDeployed: true,
  // })
  //
  // const facet = await ethers.getContract('OftWrapperFacet')
  // const diamond = await ethers.getContract(diamondContractName)

  // get facet ABI
  const contractArtifact = await hre.artifacts.readArtifact('OFTWrapperFacet')
  const contractAbi = contractArtifact.abi

  // get ethers interface
  const contractInterface = new ethers.utils.Interface(contractAbi)

  // create encoded calldata including function identifier
  const initCalldata = contractInterface.encodeFunctionData('initOFTWrapper', [
    chains.map((chain) => [chain.chainId, chain.lzChainId]),
    whitelistConfig,
  ])

  await deployFacet(hre, 'OFTWrapperFacet', { args: [] }, initCalldata)

  // // create encoded calldata
  // const initCalldata = ethers.utils.defaultAbiCoder.encode(
  //   // TODO: need to add the function identifier in the calldata
  //   ['ChainIdConfig[]', 'WhitelistConfig[]'],
  //   [
  //     chains.map(chain => [chain.chainId, chain.lzChainId]),
  //     whitelistConfig
  //   ]
  // )
  //
  // await addOrReplaceFacets([facet], diamond.address, deployedFacet.address, initCalldata )
  //
  // const isVerified = await verifyContract(hre, 'OftWrapperFacet', {
  //   address: facet.address,
  //   args: [],
  // })
  //
  // await updateDeploymentLogs('DiamondCutFacet', deployedFacet, isVerified)
}

export default func

func.id = 'deploy_oftwrapper_facet'
func.tags = ['DeployOFTWrapperFacet']
func.dependencies = [
  // 'InitialFacets',
  // diamondContractName,
  // 'InitFacets',
  // 'DeployDexManagerFacet',
]
