import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('PegNFT', {
    from: deployer,
    log: true,
    args: [
      process.env.NFT_NAME,
      process.env.NFT_SYM,
      process.env.NFT_BRIDGE_ADDR
    ]
  });
};

deployFunc.tags = ['PegNFT'];
deployFunc.dependencies = [];
export default deployFunc;
