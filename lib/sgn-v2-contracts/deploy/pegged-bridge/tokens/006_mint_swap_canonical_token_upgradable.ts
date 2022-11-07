import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('MintSwapCanonicalTokenUpgradable', {
    from: deployer,
    log: true,
    args: [
      process.env.MINT_SWAP_CANONICAL_TOKEN_NAME,
      process.env.MINT_SWAP_CANONICAL_TOKEN_SYMBOL,
      process.env.MINT_SWAP_CANONICAL_TOKEN_DECIMALS
    ],
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      execute: {
        // only called when proxy is deployed, it'll call Token contract.init
        // with proper args
        init: {
          methodName: 'init',
          args: [
            process.env.MINT_SWAP_CANONICAL_TOKEN_NAME,
            process.env.MINT_SWAP_CANONICAL_TOKEN_SYMBOL]
        }
      }
    }
  });
};

deployFunc.tags = ['MintSwapCanonicalTokenUpgradable'];
deployFunc.dependencies = [];
export default deployFunc;
