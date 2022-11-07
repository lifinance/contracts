import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    process.env.WRAPPED_BRIDGE_TOKEN_NAME,
    process.env.WRAPPED_BRIDGE_TOKEN_SYMBOL,
    process.env.WRAPPED_BRIDGE_TOKEN_BRIDGE,
    process.env.WRAPPED_BRIDGE_TOKEN_CANONICAL
  ];
  const wrappedBridgeToken = await deploy('WrappedBridgeToken', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: wrappedBridgeToken.address, constructorArguments: args });
};

deployFunc.tags = ['WrappedBridgeToken'];
deployFunc.dependencies = [];
export default deployFunc;
