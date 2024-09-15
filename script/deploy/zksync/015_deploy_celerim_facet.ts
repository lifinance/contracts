import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import {
  diamondContractName,
  deployFacet,
  addressesFile,
  AddressesFile,
} from './9999_utils'
import config from '../config/cbridge.json'
import global from '../config/global.json'
import fs from 'fs'

interface CBridgeConfig {
  [network: string]: {
    cBridge?: string
    cfUSDC?: string
    messageBus?: string
    tokenstoApprove?: string[]
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!(config as CBridgeConfig)[network.name]) {
    console.log(`No cBridge config set for ${network.name}. Skipping...`)
    return
  }

  const { messageBus } = (config as CBridgeConfig)[network.name]
  const data = JSON.parse(
    fs.readFileSync(addressesFile, 'utf8')
  ) as AddressesFile

  await deployFacet(hre, 'CelerIMFacetMutable', {
    args: [
      messageBus,
      global.refundWallet,
      data[diamondContractName],
      ethers.constants.AddressZero,
    ],
  })
}

export default func

func.id = 'deploy_celerim_facet'
func.tags = ['DeployCelerIMFacet']
func.dependencies = [
  // 'InitialFacets',
  // diamondContractName,
  // 'InitFacets',
  // 'DeployDexManagerFacet',
]
