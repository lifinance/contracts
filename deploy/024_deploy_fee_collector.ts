import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments

  const { deployer } = await getNamedAccounts()

  await deploy('FeeCollector', {
    from: deployer,
    args: [deployer],
    log: true,
    deterministicDeployment: true,
  })
}
export default func
func.id = 'deploy_fee_collector'
func.tags = ['DeployFeeCollector']
