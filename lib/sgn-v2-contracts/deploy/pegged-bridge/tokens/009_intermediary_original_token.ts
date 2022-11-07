import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const bridges = (process.env.INTERMEDIARY_ORIGINAL_TOKEN_BRIDGES as string).split(',');
  const args = [
    process.env.INTERMEDIARY_ORIGINAL_TOKEN_NAME,
    process.env.INTERMEDIARY_ORIGINAL_TOKEN_SYMBOL,
    bridges,
    process.env.INTERMEDIARY_ORIGINAL_TOKEN_CANONICAL
  ];
  const intermediaryOriginalToken = await deploy('IntermediaryOriginalToken', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: intermediaryOriginalToken.address, constructorArguments: args });
};

deployFunc.tags = ['IntermediaryOriginalToken'];
deployFunc.dependencies = [];
export default deployFunc;
