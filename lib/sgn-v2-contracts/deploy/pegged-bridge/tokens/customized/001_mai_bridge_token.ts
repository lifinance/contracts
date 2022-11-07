import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('MaiBridgeToken', {
    from: deployer,
    log: true,
    args: [
      process.env.MAI_BRIDGE_TOKEN_NAME,
      process.env.MAI_BRIDGE_TOKEN_SYMBOL,
      process.env.MAI_BRIDGE_TOKEN_BRIDGE,
      process.env.MAI_BRIDGE_TOKEN_HUB
    ]
  });
};

deployFunc.tags = ['MaiBridgeToken'];
deployFunc.dependencies = [];
export default deployFunc;
