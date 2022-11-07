import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const withdrawInbox = await deploy('WithdrawInbox', {
    from: deployer,
    log: true
  });
  await hre.run('verify:verify', { address: withdrawInbox.address });
};

deployFunc.tags = ['WithdrawInbox'];
export default deployFunc;
