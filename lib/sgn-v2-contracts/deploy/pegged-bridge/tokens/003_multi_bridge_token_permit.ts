import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('MultiBridgeTokenPermit', {
    from: deployer,
    log: true,
    args: [
      process.env.MULTI_BRIDGE_TOKEN_PERMIT_NAME,
      process.env.MULTI_BRIDGE_TOKEN_PERMIT_SYMBOL,
      process.env.MULTI_BRIDGE_TOKEN_PERMIT_DECIMALS
    ]
  });
};

deployFunc.tags = ['MultiBridgeTokenPermit'];
deployFunc.dependencies = [];
export default deployFunc;
