import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [process.env.PEGGED_TOKEN_BRIDGE_SIGS_VERIFIER];

  const peggedTokenBridgeV2 = await deploy('PeggedTokenBridgeV2', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: peggedTokenBridgeV2.address, constructorArguments: args });
};

deployFunc.tags = ['PeggedTokenBridgeV2'];
deployFunc.dependencies = [];
export default deployFunc;
