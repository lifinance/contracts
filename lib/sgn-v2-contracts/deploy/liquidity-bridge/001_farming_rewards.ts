import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [process.env.FARMING_REWARDS_SIGS_VERIFIER];

  const farmingRewards = await deploy('FarmingRewards', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: farmingRewards.address, constructorArguments: args });
};

deployFunc.tags = ['FarmingRewards'];
deployFunc.dependencies = [];
export default deployFunc;
