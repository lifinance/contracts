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
  contractAddress: string
  whitelisted: boolean
}
interface Chain {
  chainId: number
  layerZeroChainId: number
}

interface OFTWrapperConfig {
  chains: Chain[]
  whitelistedOftBridgeContracts: {
    [chain: string]: string[]
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // extract initialization data from config file
  const chains = (config as OFTWrapperConfig)['chains']

  // extract network-specific array of whitelisted addresses
  const whitelist = (config as OFTWrapperConfig)[
    'whitelistedOftBridgeContracts'
  ][network.name]

  // prepare whitelist config (=> add 'true' to every address)
  const whitelistConfig: WhitelistConfig[] = []
  for (let i = 0; i < whitelist.length; i++) {
    whitelistConfig.push({ contractAddress: whitelist[i], whitelisted: true })
  }

  // get facet ABI
  const contractArtifact = await hre.artifacts.readArtifact('OFTWrapperFacet')
  const contractAbi = contractArtifact.abi

  // get ethers interface
  const contractInterface = new ethers.utils.Interface(contractAbi)

  // create encoded calldata including function identifier
  const initCalldata = contractInterface.encodeFunctionData('initOFTWrapper', [
    chains,
    whitelistConfig,
  ])

  await deployFacet(hre, 'OFTWrapperFacet', { args: [] }, initCalldata)
}

export default func

func.id = 'deploy_oftwrapper_facet'
func.tags = ['DeployOFTWrapperFacet']
func.dependencies = ['InitialFacets', diamondContractName]
