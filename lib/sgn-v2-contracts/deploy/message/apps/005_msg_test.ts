import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('MsgTest', {
    from: deployer,
    log: true,
    args: [
      process.env.MESSAGE_BUS_ADDR,
    ]
  });
};

deployFunc.tags = ['MsgTest'];
export default deployFunc;
