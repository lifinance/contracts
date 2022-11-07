import { expect } from 'chai';
import { ethers } from 'hardhat';

import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { Govern, Staking, TestERC20 } from '../typechain';
import { advanceBlockNumber, deployContracts, getAccounts, loadFixture } from './lib/common';
import * as consts from './lib/constants';

describe('Governance Tests', function () {
  async function fixture([admin]: Wallet[]) {
    const { staking, govern, celr } = await deployContracts(admin);
    return { admin, staking, govern, celr };
  }

  let staking: Staking;
  let govern: Govern;
  let celr: TestERC20;
  let admin: Wallet;
  let validators: Wallet[];

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    staking = res.staking;
    govern = res.govern;
    celr = res.celr;
    admin = res.admin;
    await staking.setGovContract(govern.address);
    validators = await getAccounts(res.admin, [celr], 4);
    for (let i = 0; i < 4; i++) {
      await celr.connect(validators[i]).approve(staking.address, parseUnits('100'));
      await celr.connect(validators[i]).approve(govern.address, parseUnits('100'));
      await staking
        .connect(validators[i])
        .initializeValidator(validators[i].address, consts.MIN_SELF_DELEGATION, consts.COMMISSION_RATE);
      await staking.connect(validators[i]).delegate(validators[i].address, parseUnits('6'));
      await staking.connect(validators[i]).bondValidator();
    }
    await celr.approve(staking.address, parseUnits('100'));
    await celr.approve(govern.address, parseUnits('100'));
  });

  it('should createParamProposal successfully', async function () {
    const newUnbondingPeriod = consts.UNBONDING_PERIOD + 1;
    const blockNumber = await ethers.provider.getBlockNumber();
    await expect(govern.createParamProposal(consts.ENUM_UNBONDING_PERIOD, newUnbondingPeriod))
      .to.emit(govern, 'CreateParamProposal')
      .withArgs(
        0,
        admin.address,
        consts.PROPOSAL_DEPOSIT,
        consts.VOTING_PERIOD + blockNumber + 1,
        consts.ENUM_UNBONDING_PERIOD,
        newUnbondingPeriod
      );
  });

  describe('after createParamProposal successfully', async () => {
    const proposalId = 0;
    const paramType = consts.ENUM_MAX_VALIDATOR_NUM;
    const paramValue = 25;

    beforeEach(async () => {
      await govern.createParamProposal(paramType, paramValue);
    });

    it('should fail to voteParam if not validator', async function () {
      await expect(govern.voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES)).to.be.revertedWith(
        'Voter is not a bonded validator'
      );
    });

    it('should fail to voteParam for a proposal with an invalid status', async function () {
      await expect(
        govern.connect(validators[0]).voteParam(proposalId + 1, consts.ENUM_VOTE_OPTION_YES)
      ).to.be.revertedWith('Invalid proposal status');
    });

    it('should vote successfully as a validator', async function () {
      await expect(govern.connect(validators[0]).voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES))
        .to.emit(govern, 'VoteParam')
        .withArgs(proposalId, validators[0].address, consts.ENUM_VOTE_OPTION_YES);
    });

    describe('after a validator votes successfully', async () => {
      beforeEach(async () => {
        await govern.connect(validators[0]).voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES);
      });

      it('should fail to vote for the same proposal twice', async function () {
        await expect(
          govern.connect(validators[0]).voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES)
        ).to.be.revertedWith('Voter has voted');
      });

      it('should fail to confirmParamProposal before the vote deadline', async function () {
        await expect(govern.confirmParamProposal(proposalId)).to.be.revertedWith('Vote deadline not reached');
      });

      it('should accept proposal after over 2/3 voted for Yes', async function () {
        await expect(govern.connect(validators[1]).voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES))
          .to.emit(govern, 'VoteParam')
          .withArgs(proposalId, validators[1].address, consts.ENUM_VOTE_OPTION_YES);
        await govern.connect(validators[2]).voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES);
        await advanceBlockNumber(consts.VOTING_PERIOD);
        await expect(govern.confirmParamProposal(proposalId))
          .to.emit(govern, 'ConfirmParamProposal')
          .withArgs(proposalId, true, paramType, paramValue);

        const val = await staking.params(consts.ENUM_MAX_VALIDATOR_NUM);
        expect(val).to.equal(paramValue);
      });

      describe('after passing the vote deadline with less than 2/3 votes', async () => {
        beforeEach(async () => {
          await advanceBlockNumber(consts.VOTING_PERIOD);
        });

        it('should fail to vote after the vote deadline', async function () {
          await expect(
            govern.connect(validators[2]).voteParam(proposalId, consts.ENUM_VOTE_OPTION_YES)
          ).to.be.revertedWith('Vote deadline passed');
        });

        it('should reject proposal successfully', async function () {
          await expect(govern.confirmParamProposal(proposalId))
            .to.emit(govern, 'ConfirmParamProposal')
            .withArgs(proposalId, false, paramType, paramValue);

          const val = await staking.params(consts.ENUM_MAX_VALIDATOR_NUM);
          expect(val).to.equal(consts.MAX_VALIDATOR_NUM);
        });
      });
    });
  });
});
