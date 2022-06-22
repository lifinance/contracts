import { ethers, network } from 'hardhat'
import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { addOrReplaceFacets } from '../utils/diamond'
import config from '../config/dexs'
import allowedFuncSignatures from '../config/dexfuncs'
import { DexManagerFacet } from '../typechain'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  await deploy('DexManagerFacet', {
    from: deployer,
    log: true,
    deterministicDeployment: true,
  })

  const dexManagerFacet = await ethers.getContract('DexManagerFacet')

  const diamond = await ethers.getContract('LiFiDiamond')

  await addOrReplaceFacets([dexManagerFacet], diamond.address)

  const dexs = config[network.name].map((d: string) => d.toLowerCase())
  if (dexs && dexs.length) {
    console.log('Adding DEXs to whitelist...')
    const dexMgr = <DexManagerFacet>(
      await ethers.getContractAt('DexManagerFacet', diamond.address)
    )
    const approvedDEXs = (await dexMgr.approvedDexs()).map((d: string) =>
      d.toLowerCase()
    )

    let tx
    if (JSON.stringify(approvedDEXs) === JSON.stringify(dexs)) {
      console.log('DEXs already whitelisted.')
    } else {
      tx = await dexMgr.batchAddDex(dexs)
      await tx.wait()
    }

    // Approve function signatures
    tx = await dexMgr.batchSetFunctionApprovalBySignature(
      allowedFuncSignatures,
      true
    )
    await tx.wait()

    console.log('Done!')
  }
}
export default func
func.id = 'deploy_dex_manager_facet'
func.tags = ['DeployDexManagerFacet']
func.dependencies = ['InitialFacets', 'LiFiDiamond', 'InitFacets']
