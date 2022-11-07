import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    process.env.FRAX_BRIDGE_TOKEN_NAME,
    process.env.FRAX_BRIDGE_TOKEN_SYMBOL,
    process.env.FRAX_BRIDGE_TOKEN_BRIDGE,
    process.env.FRAX_BRIDGE_TOKEN_CANONICAL
  ];

  const fraxBridgeToken = await deploy('FraxBridgeToken', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: fraxBridgeToken.address, constructorArguments: args });
};

deployFunc.tags = ['FraxBridgeToken'];
deployFunc.dependencies = [];
export default deployFunc;
