import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const args = [
    process.env.MINT_SWAP_CANONICAL_TOKEN_NAME,
    process.env.MINT_SWAP_CANONICAL_TOKEN_SYMBOL,
    process.env.MINT_SWAP_CANONICAL_TOKEN_DECIMALS
  ];
  const mintSwapCanonicalToken = await deploy('MintSwapCanonicalToken', {
    from: deployer,
    log: true,
    args: args
  });
  await hre.run('verify:verify', { address: mintSwapCanonicalToken.address, constructorArguments: args });
};

deployFunc.tags = ['MintSwapCanonicalToken'];
deployFunc.dependencies = [];
export default deployFunc;
