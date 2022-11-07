import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('DummySwap', {
    from: deployer,
    log: true,
    args: [50000] // 5% fake slippage
  });
};

deployFunc.tags = ['DummySwap'];
export default deployFunc;
