import { expect } from 'chai';
import { ethers } from 'hardhat';

import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { Staking, StakingReward, TestERC20 } from '../typechain';
import { deployContracts, getAccounts, loadFixture } from './lib/common';
import * as consts from './lib/constants';
import { getStakingRewardRequest } from './lib/proto';

describe('StakingReward Tests', function () {
  async function fixture([admin]: Wallet[]) {
    const { staking, stakingReward, celr } = await deployContracts(admin);
    return { admin, staking, stakingReward, celr };
  }

  const abiCoder = ethers.utils.defaultAbiCoder;

  let staking: Staking;
  let reward: StakingReward;
  let celr: TestERC20;
  let validators: Wallet[];
  let signers: Wallet[];
  let chainId: number;

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    staking = res.staking;
    reward = res.stakingReward;
    celr = res.celr;
    const accounts = await getAccounts(res.admin, [celr], 6);
    validators = [accounts[0], accounts[1], accounts[2], accounts[3]];
    signers = [accounts[0], accounts[1], accounts[4], accounts[5]];
    for (let i = 0; i < 4; i++) {
      await celr.connect(validators[i]).approve(staking.address, parseUnits('100'));
      await celr.connect(validators[i]).approve(reward.address, parseUnits('100'));
      await staking
        .connect(validators[i])
        .initializeValidator(signers[i].address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE);
      await staking.connect(validators[i]).delegate(validators[i].address, consts.MIN_VALIDATOR_TOKENS);
      await staking.connect(validators[i]).bondValidator();
    }
    await reward.connect(validators[0]).contributeToRewardPool(100);
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  it('should fail to contribute to reward pool when paused', async function () {
    await reward.pause();
    await expect(reward.contributeToRewardPool(100)).to.be.revertedWith('Pausable: paused');
  });

  it('should contribute to reward pool successfully', async function () {
    await expect(reward.connect(validators[0]).contributeToRewardPool(100))
      .to.emit(reward, 'StakingRewardContributed')
      .withArgs(validators[0].address, 100);
  });

  it('should update the commission rate lock successfully', async function () {
    const newRate = consts.COMMISSION_RATE + 10;
    const data = abiCoder.encode(['uint256'], [newRate]);
    await expect(staking.connect(validators[0]).updateCommissionRate(newRate))
      .to.emit(staking, 'ValidatorNotice')
      .withArgs(validators[0].address, 'commission', data, consts.ZERO_ADDR);
  });

  it('should fail to claim reward when paused', async function () {
    await reward.pause();
    const r = await getStakingRewardRequest(
      validators[0].address,
      parseUnits('100', 'wei'),
      signers,
      chainId,
      reward.address
    );
    await expect(reward.claimReward(r.rewardBytes, r.sigs)).to.be.revertedWith('Pausable: paused');
  });

  it('should claim reward successfully', async function () {
    let r = await getStakingRewardRequest(
      validators[0].address,
      parseUnits('40', 'wei'),
      signers,
      chainId,
      reward.address
    );
    await expect(reward.claimReward(r.rewardBytes, r.sigs))
      .to.emit(reward, 'StakingRewardClaimed')
      .withArgs(validators[0].address, 40);

    r = await getStakingRewardRequest(validators[0].address, parseUnits('90', 'wei'), signers, chainId, reward.address);
    await expect(reward.claimReward(r.rewardBytes, r.sigs))
      .to.emit(reward, 'StakingRewardClaimed')
      .withArgs(validators[0].address, 50);
  });

  it('should fail to claim reward more than amount in reward pool', async function () {
    const r = await getStakingRewardRequest(
      validators[0].address,
      parseUnits('101', 'wei'),
      signers,
      chainId,
      reward.address
    );
    await expect(reward.claimReward(r.rewardBytes, r.sigs)).to.be.revertedWith(
      'ERC20: transfer amount exceeds balance'
    );
  });

  it('should fail to claim reward if there is no new reward', async function () {
    const r = await getStakingRewardRequest(validators[0].address, parseUnits('0'), signers, chainId, reward.address);
    await expect(reward.claimReward(r.rewardBytes, r.sigs)).to.be.revertedWith('No new reward');
  });

  it('should fail to claim reward with insufficient signatures', async function () {
    const r = await getStakingRewardRequest(
      validators[0].address,
      parseUnits('10', 'wei'),
      [signers[0], signers[1]],
      chainId,
      reward.address
    );
    await expect(reward.claimReward(r.rewardBytes, r.sigs)).to.be.revertedWith('Quorum not reached');
  });

  it('should fail to claim reward with disordered signatures', async function () {
    const r = await getStakingRewardRequest(
      validators[0].address,
      parseUnits('10', 'wei'),
      signers,
      chainId,
      reward.address
    );
    await expect(reward.claimReward(r.rewardBytes, [r.sigs[0], r.sigs[2], r.sigs[1], r.sigs[3]])).to.be.revertedWith(
      'Signers not in ascending order'
    );
    await expect(reward.claimReward(r.rewardBytes, [r.sigs[0], r.sigs[0], r.sigs[1], r.sigs[2]])).to.be.revertedWith(
      'Signers not in ascending order'
    );
  });
});
