import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('Staking', {
    from: deployer,
    log: true,
    args: [
      process.env.CELR,
      process.env.PROPOSAL_DEPOSIT,
      process.env.VOTING_PERIOD,
      process.env.UNBONDING_PERIOD,
      process.env.MAX_VALIDATOR_NUM,
      process.env.MIN_VALIDATOR_TOKENS,
      process.env.MIN_SELF_DELEGATION,
      process.env.ADVANCE_NOTICE_PERIOD,
      process.env.VALIDATOR_BOND_INTERVAL,
      process.env.MAX_SLASH_FACTOR
    ]
  });
  const staking = await deployments.get('Staking');
  await deploy('SGN', {
    from: deployer,
    log: true,
    args: [staking.address]
  });
  await deploy('StakingReward', {
    from: deployer,
    log: true,
    args: [staking.address]
  });
  const stakingReward = await deployments.get('StakingReward');
  await deploy('Govern', {
    from: deployer,
    log: true,
    args: [staking.address, process.env.CELR, stakingReward.address]
  });
  await deploy('Viewer', {
    from: deployer,
    log: true,
    args: [staking.address]
  });
};

deployFunc.tags = ['SGNStaking'];
deployFunc.dependencies = [];
export default deployFunc;
