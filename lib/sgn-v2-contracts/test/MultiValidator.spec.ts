import { expect } from 'chai';

import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { Staking, TestERC20 } from '../typechain';
import { advanceBlockNumber, deployContracts, getAccounts, loadFixture } from './lib/common';
import * as consts from './lib/constants';

describe('Multiple validators Tests', function () {
  async function fixture([admin]: Wallet[]) {
    const { staking, celr } = await deployContracts(admin);
    return { admin, staking, celr };
  }
  let staking: Staking;
  let celr: TestERC20;
  let validators: Wallet[];

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    staking = res.staking;
    celr = res.celr;
    validators = await getAccounts(res.admin, [celr], 8);
    await celr.approve(staking.address, parseUnits('100'));
    const stakes = [
      parseUnits('6'),
      parseUnits('2'),
      parseUnits('10'),
      parseUnits('5'),
      parseUnits('7'),
      parseUnits('3'),
      parseUnits('9')
    ];
    for (let i = 0; i < 8; i++) {
      await celr.connect(validators[i]).approve(staking.address, parseUnits('100'));
      await staking
        .connect(validators[i])
        .initializeValidator(validators[i].address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE);
      if (i < 7) {
        await staking.connect(validators[i]).delegate(validators[i].address, consts.VALIDATOR_STAKE);
        await staking.delegate(validators[i].address, stakes[i]);
        await staking.connect(validators[i]).bondValidator();
      }
    }
  });

  it('should getQuorumTokens successfully', async function () {
    const quorum = await staking.getQuorumTokens();
    expect(quorum).to.equal(parseUnits('42').add(1));
  });

  it('should fail to bondValidator before delegating enough stake', async function () {
    await staking.connect(validators[7]).delegate(validators[7].address, parseUnits('2'));
    await expect(staking.connect(validators[7]).bondValidator()).to.be.revertedWith('Insufficient tokens');
  });

  it('should replace a current validator by calling bondValidator with enough stake', async function () {
    await staking.connect(validators[7]).delegate(validators[7].address, parseUnits('8'));
    await expect(staking.connect(validators[7]).bondValidator())
      .to.emit(staking, 'ValidatorStatusUpdate')
      .withArgs(validators[1].address, consts.STATUS_UNBONDING)
      .to.emit(staking, 'ValidatorStatusUpdate')
      .withArgs(validators[7].address, consts.STATUS_BONDED);

    const quorum = await staking.getQuorumTokens();
    expect(quorum).to.equal(parseUnits('68').mul(2).div(3).add(1));
  });

  it('should remove validator due to undelegate and add new validator successfully', async function () {
    await expect(staking.connect(validators[1]).undelegateShares(validators[1].address, parseUnits('2')))
      .to.emit(staking, 'ValidatorStatusUpdate')
      .withArgs(validators[1].address, consts.STATUS_UNBONDING);
    let quorum = await staking.getQuorumTokens();
    expect(quorum).to.equal(parseUnits('58').mul(2).div(3).add(1));

    await staking.connect(validators[7]).delegate(validators[7].address, parseUnits('8'));
    await expect(staking.connect(validators[7]).bondValidator())
      .to.emit(staking, 'ValidatorStatusUpdate')
      .withArgs(validators[7].address, consts.STATUS_BONDED);
    quorum = await staking.getQuorumTokens();
    expect(quorum).to.equal(parseUnits('68').mul(2).div(3).add(1));
  });

  describe('after one validator is replaced', async () => {
    beforeEach(async () => {
      await staking.connect(validators[7]).delegate(validators[7].address, parseUnits('8'));
      await staking.connect(validators[7]).bondValidator();
    });

    it('should confirmUnbondedValidator only after unbondBlock', async function () {
      const res = await staking.validators(validators[1].address);
      expect(res.status).to.equal(consts.STATUS_UNBONDING);

      await expect(staking.confirmUnbondedValidator(validators[1].address)).to.be.revertedWith(
        'Unbond block not reached'
      );

      await advanceBlockNumber(consts.UNBONDING_PERIOD);
      await expect(staking.confirmUnbondedValidator(validators[1].address))
        .to.emit(staking, 'ValidatorStatusUpdate')
        .withArgs(validators[1].address, consts.STATUS_UNBONDED);
    });

    it('should replace current min stake validator with the unbonding validator', async function () {
      await staking.connect(validators[1]).delegate(validators[1].address, parseUnits('5'));
      await expect(staking.connect(validators[1]).bondValidator())
        .to.emit(staking, 'ValidatorStatusUpdate')
        .withArgs(validators[5].address, consts.STATUS_UNBONDING)
        .to.emit(staking, 'ValidatorStatusUpdate')
        .withArgs(validators[1].address, consts.STATUS_BONDED);

      await staking.delegate(validators[1].address, parseUnits('5'));
      await staking.delegate(validators[5].address, parseUnits('3'));
      const quorum = await staking.getQuorumTokens();
      expect(quorum).to.equal(parseUnits('77').mul(2).div(3).add(1));
    });
  });
});
