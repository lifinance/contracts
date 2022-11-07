import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('RestrictedMultiBridgeTokenOwner', {
    from: deployer,
    log: true,
    args: [
      process.env.RESTRICTED_MULTI_BRIDGE_TOKEN_OWNER_TOKEN,
      process.env.RESTRICTED_MULTI_BRIDGE_TOKEN_OWNER_BRIDGE
    ]
  });
};

deployFunc.tags = ['RestrictedMultiBridgeTokenOwner'];
deployFunc.dependencies = [];
export default deployFunc;
