import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('MultiBridgeToken', {
    from: deployer,
    log: true,
    args: [
      process.env.MULTI_BRIDGE_TOKEN_NAME,
      process.env.MULTI_BRIDGE_TOKEN_SYMBOL,
      process.env.MULTI_BRIDGE_TOKEN_DECIMALS
    ]
  });
};

deployFunc.tags = ['MultiBridgeToken'];
deployFunc.dependencies = [];
export default deployFunc;
