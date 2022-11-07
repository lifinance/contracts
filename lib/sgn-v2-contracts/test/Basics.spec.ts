import { expect } from 'chai';
import { ethers } from 'hardhat';

import { keccak256 } from '@ethersproject/solidity';
import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { SGN, Staking, TestERC20, Viewer } from '../typechain';
import { advanceBlockNumber, deployContracts, getAccounts, loadFixture } from './lib/common';
import * as consts from './lib/constants';

describe('Basic Tests', function () {
  async function fixture([admin]: Wallet[]) {
    const { staking, sgn, viewer, celr } = await deployContracts(admin);
    return { admin, staking, sgn, viewer, celr };
  }

  const abiCoder = ethers.utils.defaultAbiCoder;

  let staking: Staking;
  let sgn: SGN;
  let viewer: Viewer;
  let celr: TestERC20;
  let admin: Wallet;
  let validator: Wallet;
  let delegator: Wallet;

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    staking = res.staking;
    sgn = res.sgn;
    viewer = res.viewer;
    celr = res.celr;
    admin = res.admin;
    const accounts = await getAccounts(res.admin, [celr], 2);
    validator = accounts[0];
    delegator = accounts[1];
    await celr.connect(validator).approve(staking.address, parseUnits('100'));
    await celr.connect(delegator).approve(staking.address, parseUnits('100'));
  });

  it('should fail to delegate to an uninitialized validator', async function () {
    await expect(staking.delegate(validator.address, consts.DELEGATOR_STAKE)).to.be.revertedWith(
      'Validator is not initialized'
    );
  });

  it('should fail to initialize a validator when paused', async function () {
    await staking.pause();
    await expect(
      staking
        .connect(validator)
        .initializeValidator(validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE)
    ).to.be.revertedWith('Pausable: paused');
  });

  it('should fail to initialize a validator with insufficient min self delegation', async function () {
    await expect(
      staking.connect(validator).initializeValidator(validator.address, parseUnits('1'), consts.COMMISSION_RATE)
    ).to.be.revertedWith('Insufficient min self delegation');
  });

  it('should fail to initialize a validator if self delegation fails', async function () {
    await expect(
      staking.initializeValidator(admin.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE)
    ).to.be.revertedWith('ERC20: insufficient allowance');
  });

  it('should fail to initialize a non-whitelisted validator when whitelist is enabled', async function () {
    await staking.setWhitelistEnabled(true);
    await expect(
      staking
        .connect(validator)
        .initializeValidator(validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE)
    ).to.be.revertedWith('Caller is not whitelisted');
  });

  it('should initialize a whitelisted validator successfully when whitelist is enabled', async function () {
    await staking.setWhitelistEnabled(true);
    await staking.addWhitelisted(validator.address);

    const data = abiCoder.encode(
      ['address', 'uint256', 'uint256'],
      [validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE]
    );
    await expect(
      staking
        .connect(validator)
        .initializeValidator(validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE)
    )
      .to.emit(staking, 'ValidatorNotice')
      .withArgs(validator.address, 'init', data, consts.ZERO_ADDR);
  });

  it('should initialize a validator and update sgn address successfully', async function () {
    const data = abiCoder.encode(
      ['address', 'uint256', 'uint256'],
      [validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE]
    );
    await expect(
      staking
        .connect(validator)
        .initializeValidator(validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE)
    )
      .to.emit(staking, 'ValidatorNotice')
      .withArgs(validator.address, 'init', data, consts.ZERO_ADDR);

    const sgnAddr = keccak256(['string'], ['sgnaddr1']);
    await expect(sgn.connect(validator).updateSgnAddr(sgnAddr))
      .to.emit(sgn, 'SgnAddrUpdate')
      .withArgs(validator.address, '0x', sgnAddr)
      .to.emit(staking, 'ValidatorNotice')
      .withArgs(validator.address, 'sgn-addr', sgnAddr, sgn.address);
  });

  describe('after one validator finishes initialization', async () => {
    const sgnAddr = keccak256(['string'], ['sgnaddr']);
    beforeEach(async () => {
      await staking
        .connect(validator)
        .initializeValidator(validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE);
      await sgn.connect(validator).updateSgnAddr(sgnAddr);
    });

    it('should fail to initialize the same validator twice', async function () {
      await expect(
        staking
          .connect(validator)
          .initializeValidator(validator.address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE)
      ).to.be.revertedWith('Validator is initialized');
    });

    it('should pass sgn address update', async function () {
      const newSgnAddr = keccak256(['string'], ['sgnaddr_new']);
      await expect(sgn.connect(validator).updateSgnAddr(newSgnAddr))
        .to.emit(sgn, 'SgnAddrUpdate')
        .withArgs(validator.address, sgnAddr, newSgnAddr)
        .to.emit(staking, 'ValidatorNotice')
        .withArgs(validator.address, 'sgn-addr', newSgnAddr, sgn.address);

      await expect(sgn.connect(admin).updateSgnAddr(newSgnAddr)).to.be.revertedWith('Not unbonded validator');
    });

    it('should fail to delegate when paused', async function () {
      await staking.pause();
      await expect(staking.delegate(validator.address, consts.DELEGATOR_STAKE)).to.be.revertedWith('Pausable: paused');
    });

    it('should delegate to validator by a delegator successfully', async function () {
      await expect(staking.connect(delegator).delegate(validator.address, consts.DELEGATOR_STAKE))
        .to.emit(staking, 'DelegationUpdate')
        .withArgs(
          validator.address,
          delegator.address,
          consts.DELEGATOR_STAKE.add(consts.MIN_SELF_DELEGATION),
          consts.DELEGATOR_STAKE,
          consts.DELEGATOR_STAKE
        );
    });

    it('should fail to bondValidator before delegating enough stake', async function () {
      const shouldBond = await viewer.shouldBondValidator(validator.address);
      expect(shouldBond).to.equal(false);
      await expect(staking.connect(validator).bondValidator()).to.be.revertedWith('Not have min tokens');
    });

    describe('after one delegator delegates enough stake to the validator', async () => {
      beforeEach(async () => {
        await staking.connect(delegator).delegate(validator.address, consts.DELEGATOR_STAKE);
      });

      it('should fail to bondValidator before self delegating minSelfDelegation', async function () {
        await staking.connect(validator).undelegateShares(validator.address, parseUnits('1'));
        await expect(staking.connect(validator).bondValidator()).to.be.revertedWith('Not have min tokens');
      });

      it('should undelegate from unbonded validator by delegator successfully', async function () {
        await expect(staking.connect(delegator).undelegateShares(validator.address, consts.DELEGATOR_STAKE))
          .to.emit(staking, 'Undelegated')
          .withArgs(validator.address, delegator.address, consts.DELEGATOR_STAKE);
      });

      it('should fail to undelegate from unbonded validator more than it delegated', async function () {
        await expect(staking.connect(delegator).undelegateShares(validator.address, consts.DELEGATOR_STAKE.add(1000)))
          .to.be.reverted;
      });

      it('should fail to undelegate from unbonded validator with amount smaller than 1 share', async function () {
        await expect(staking.connect(delegator).undelegateShares(validator.address, 1000)).to.be.revertedWith(
          'Minimal amount is 1 share'
        );
      });

      it('should fail to drain token when not paused', async function () {
        await expect(staking.drainToken(consts.DELEGATOR_STAKE)).to.be.revertedWith('Pausable: not paused');
      });

      it('should drainToken successfully when paused', async function () {
        await staking.pause();
        const balanceBefore = await celr.balanceOf(admin.address);
        await staking.drainToken(consts.DELEGATOR_STAKE);
        const balanceAfter = await celr.balanceOf(admin.address);
        expect(balanceAfter.sub(balanceBefore)).to.equal(consts.DELEGATOR_STAKE);
      });

      describe('after one delegator delegates enough stake to the validator', async () => {
        beforeEach(async () => {
          await staking.connect(validator).delegate(validator.address, consts.VALIDATOR_STAKE);
        });

        it('should bondValidator successfully', async function () {
          const shouldBond = await viewer.shouldBondValidator(validator.address);
          expect(shouldBond).to.equal(true);
          await expect(staking.connect(validator).bondValidator())
            .to.emit(staking, 'ValidatorStatusUpdate')
            .withArgs(validator.address, consts.STATUS_BONDED);
        });

        it('should increase min self delegation and bondValidator successfully', async function () {
          const higherMinSelfDelegation = consts.MIN_SELF_DELEGATION.add(1000000);
          const data = abiCoder.encode(['uint256'], [higherMinSelfDelegation]);
          await expect(staking.connect(validator).updateMinSelfDelegation(higherMinSelfDelegation))
            .to.emit(staking, 'ValidatorNotice')
            .withArgs(validator.address, 'min-self-delegation', data, consts.ZERO_ADDR);

          await expect(staking.connect(validator).bondValidator())
            .to.emit(staking, 'ValidatorStatusUpdate')
            .withArgs(validator.address, consts.STATUS_BONDED);
        });

        it('should decrease min self delegation and only able to bondValidator after notice period', async function () {
          let minSelfDelegation = consts.MIN_SELF_DELEGATION.add(1000000);
          await staking.connect(validator).updateMinSelfDelegation(minSelfDelegation);
          minSelfDelegation = consts.MIN_SELF_DELEGATION.add(10);
          const data = abiCoder.encode(['uint256'], [minSelfDelegation]);
          await expect(staking.connect(validator).updateMinSelfDelegation(minSelfDelegation))
            .to.emit(staking, 'ValidatorNotice')
            .withArgs(validator.address, 'min-self-delegation', data, consts.ZERO_ADDR);

          await expect(staking.connect(validator).bondValidator()).to.be.revertedWith('Bond block not reached');

          await advanceBlockNumber(consts.ADVANCE_NOTICE_PERIOD);
          await expect(staking.connect(validator).bondValidator())
            .to.emit(staking, 'ValidatorStatusUpdate')
            .withArgs(validator.address, consts.STATUS_BONDED);
        });

        describe('after one validator bondValidator', async () => {
          beforeEach(async () => {
            await staking.connect(validator).bondValidator();
          });

          it('should fail to undelegate with amount smaller than 1 share', async function () {
            await expect(staking.connect(delegator).undelegateShares(validator.address, 1000)).to.be.revertedWith(
              'Minimal amount is 1 share'
            );
          });

          it('should fail to undelegate more than it delegated', async function () {
            await expect(
              staking.connect(delegator).undelegateShares(validator.address, consts.DELEGATOR_STAKE.add(1000))
            ).to.be.reverted;
          });

          it('should remove the validator after validator undelegate to become under minSelfDelegation', async function () {
            await expect(staking.connect(validator).undelegateShares(validator.address, consts.MIN_SELF_DELEGATION))
              .to.emit(staking, 'ValidatorStatusUpdate')
              .withArgs(validator.address, consts.STATUS_UNBONDING);
          });

          it('should remove the validator after delegator undelegate to become under minStakingPool', async function () {
            await expect(staking.connect(delegator).undelegateShares(validator.address, consts.DELEGATOR_STAKE))
              .to.emit(staking, 'ValidatorStatusUpdate')
              .withArgs(validator.address, consts.STATUS_UNBONDING)
              .to.emit(staking, 'DelegationUpdate')
              .withArgs(
                validator.address,
                delegator.address,
                consts.VALIDATOR_STAKE.add(consts.MIN_SELF_DELEGATION),
                0,
                parseUnits('0').sub(consts.DELEGATOR_STAKE)
              );
          });

          it('should pass min self delegation updates', async function () {
            let minSelfDelegation = consts.MIN_SELF_DELEGATION.add(1000000);
            const data = abiCoder.encode(['uint256'], [minSelfDelegation]);
            await expect(staking.connect(validator).updateMinSelfDelegation(minSelfDelegation))
              .to.emit(staking, 'ValidatorNotice')
              .withArgs(validator.address, 'min-self-delegation', data, consts.ZERO_ADDR);

            minSelfDelegation = consts.MIN_SELF_DELEGATION.add(100);
            await expect(staking.connect(validator).updateMinSelfDelegation(minSelfDelegation)).to.be.revertedWith(
              'Validator is bonded'
            );

            minSelfDelegation = consts.MIN_SELF_DELEGATION.sub(100);
            await expect(staking.connect(validator).updateMinSelfDelegation(minSelfDelegation)).to.be.revertedWith(
              'Insufficient min self delegation'
            );
          });

          describe('after a delegator undelegate', async () => {
            beforeEach(async () => {
              await staking.connect(delegator).undelegateShares(validator.address, parseUnits('2'));
            });

            it('should fail to undelegate with a total more than it delegated', async function () {
              await expect(staking.connect(delegator).undelegateShares(validator.address, consts.DELEGATOR_STAKE)).to.be
                .reverted;
            });

            it('should completeUndelegate successfully', async function () {
              // before withdrawTimeout
              await expect(staking.connect(delegator).completeUndelegate(validator.address)).to.be.revertedWith(
                'No undelegation ready to be completed'
              );

              // after withdrawTimeout
              await advanceBlockNumber(consts.UNBONDING_PERIOD);
              // first completeUndelegate
              await expect(staking.connect(delegator).completeUndelegate(validator.address))
                .to.emit(staking, 'Undelegated')
                .withArgs(validator.address, delegator.address, parseUnits('2'));

              // second completeUndelegate
              await expect(staking.connect(delegator).completeUndelegate(validator.address)).to.be.revertedWith(
                'No undelegation ready to be completed'
              );
            });

            it('should pass with multiple undelegations', async function () {
              await staking.connect(delegator).undelegateShares(validator.address, parseUnits('1'));

              let res = await staking.getDelegatorInfo(validator.address, delegator.address);
              expect(res.shares).to.equal(parseUnits('3'));
              expect(res.undelegations[0].shares).to.equal(parseUnits('2'));
              expect(res.undelegations[1].shares).to.equal(parseUnits('1'));

              await advanceBlockNumber(consts.UNBONDING_PERIOD);
              await staking.connect(delegator).undelegateShares(validator.address, parseUnits('1'));

              await expect(staking.connect(delegator).completeUndelegate(validator.address))
                .to.emit(staking, 'Undelegated')
                .withArgs(validator.address, delegator.address, parseUnits('3'));

              res = await staking.getDelegatorInfo(validator.address, delegator.address);
              expect(res.shares).to.equal(parseUnits('2'));
              expect(res.undelegations[0].shares).to.equal(parseUnits('1'));

              await expect(staking.connect(delegator).completeUndelegate(validator.address)).to.be.revertedWith(
                'No undelegation ready to be completed'
              );

              await advanceBlockNumber(consts.UNBONDING_PERIOD);
              await expect(staking.connect(delegator).completeUndelegate(validator.address))
                .to.emit(staking, 'Undelegated')
                .withArgs(validator.address, delegator.address, parseUnits('1'));

              res = await staking.getDelegatorInfo(validator.address, delegator.address);
              expect(res.shares).to.equal(parseUnits('2'));
              expect(res.undelegations.length).to.equal(0);
            });
          });
        });
      });
    });
  });
});
