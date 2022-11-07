import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    process.env.INTERMEDIARY_BRIDGE_TOKEN_NAME,
    process.env.INTERMEDIARY_BRIDGE_TOKEN_SYMBOL,
    process.env.INTERMEDIARY_BRIDGE_TOKEN_BRIDGE,
    process.env.INTERMEDIARY_BRIDGE_TOKEN_CANONICAL
  ];
  const intermediaryBridgeToken = await deploy('IntermediaryBridgeToken', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: intermediaryBridgeToken.address, constructorArguments: args });
};

deployFunc.tags = ['IntermediaryBridgeToken'];
deployFunc.dependencies = [];
export default deployFunc;
