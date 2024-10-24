import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers, network } from 'hardhat'
import { addOrReplaceFacets } from '../../utils/diamond'
import { DexManagerFacet } from '../../../typechain'
import {
  diamondContractName,
  updateDeploymentLogs,
  verifyContract,
} from './9999_utils'
import dexsConfig from '../../../config/dexs.json'
import sigsConfig from '../../../config/sigs.json'

interface DexsConfig {
  [network: string]: string[]
}

interface SigsConfig {
  sigs: string[]
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Protect against unwanted redeployments
  if (network.name !== 'zksync' && network.name !== 'zksyncGoerli') {
    return
  }

  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const deployedDexManagerFacet = await deploy('DexManagerFacet', {
    from: deployer,
    log: true,
    skipIfAlreadyDeployed: true,
  })

  const dexManagerFacet = await ethers.getContract('DexManagerFacet')
  const diamond = await ethers.getContract(diamondContractName)

  await addOrReplaceFacets([dexManagerFacet], diamond.address)

  const dexs = (dexsConfig as DexsConfig)[network.name].map((d: string) =>
    d.toLowerCase()
  )

  if (dexs && dexs.length) {
    console.log('Checking DEXs whitelist...')

    const dexMgr = <DexManagerFacet>(
      await ethers.getContractAt('DexManagerFacet', diamond.address)
    )

    const approvedDexs = (await dexMgr.approvedDexs()).map((d: string) =>
      d.toLowerCase()
    )
    const notApprovedDexs = dexs.filter((dex) => !approvedDexs.includes(dex))

    if (notApprovedDexs.length > 0) {
      console.log('Updating DEX whitelist...')
      const tx = await dexMgr.batchAddDex(notApprovedDexs)
      await tx.wait()
    } else {
      console.log('DEXs already whitelisted.')
    }

    // Approve function signatures
    console.log('Checking DEXs signatures whitelist...')

    const sigs = (sigsConfig as SigsConfig).sigs

    const isSigApproved = await Promise.all(
      sigs.map((sig) => {
        return dexMgr.isFunctionApproved(sig)
      })
    )
    const notApprovedSigs = sigs.filter((_, index) => !isSigApproved[index])

    if (notApprovedSigs.length > 0) {
      console.log('Updating DEX signatures...')
      const tx = await dexMgr.batchSetFunctionApprovalBySignature(
        notApprovedSigs,
        true
      )
      await tx.wait()
    } else {
      console.log('DEX signatures already whitelisted.')
    }

    console.log('Done!')
  }

  const isVerified = await verifyContract(hre, 'DexManagerFacet', {
    address: dexManagerFacet.address,
  })

  await updateDeploymentLogs(
    'DexManagerFacet',
    deployedDexManagerFacet,
    isVerified
  )
}

export default func

func.id = 'deploy_dex_manager_facet'
func.tags = ['DeployDexManagerFacet']
func.dependencies = ['InitialFacets', diamondContractName, 'InitFacets']
