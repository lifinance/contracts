import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('SingleBridgeTokenPermit', {
    from: deployer,
    log: true,
    args: [
      process.env.SINGLE_BRIDGE_TOKEN_PERMIT_NAME,
      process.env.SINGLE_BRIDGE_TOKEN_PERMIT_SYMBOL,
      process.env.SINGLE_BRIDGE_TOKEN_PERMIT_DECIMALS,
      process.env.SINGLE_BRIDGE_TOKEN_PERMIT_BRIDGE
    ]
  });
};

deployFunc.tags = ['SingleBridgeTokenPermit'];
deployFunc.dependencies = [];
export default deployFunc;
