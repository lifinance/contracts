import { expect } from 'chai';
import { ethers } from 'hardhat';

import { keccak256 } from '@ethersproject/solidity';
import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { SGN, Staking, TestERC20 } from '../typechain';
import { deployContracts, getAccounts, loadFixture } from './lib/common';
import * as consts from './lib/constants';

describe('Validator Signer Tests', function () {
  async function fixture([admin]: Wallet[]) {
    const { staking, sgn, celr } = await deployContracts(admin);
    return { admin, staking, sgn, celr };
  }
  const abiCoder = ethers.utils.defaultAbiCoder;

  let staking: Staking;
  let sgn: SGN;
  let celr: TestERC20;
  let admin: Wallet;
  let validators: Wallet[];
  let signers: Wallet[];

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    staking = res.staking;
    sgn = res.sgn;
    celr = res.celr;
    admin = res.admin;
    const accounts = await getAccounts(res.admin, [celr], 4);
    validators = [accounts[0], accounts[1]];
    signers = [accounts[2], accounts[3]];
    await celr.connect(validators[0]).approve(staking.address, parseUnits('100'));
    await celr.connect(validators[1]).approve(staking.address, parseUnits('100'));
    await staking
      .connect(validators[0])
      .initializeValidator(signers[0].address, consts.MIN_VALIDATOR_TOKENS, consts.COMMISSION_RATE);
  });

  it('should fail to initialize a validator using another validator as signer', async function () {
    await expect(
      staking
        .connect(validators[1])
        .initializeValidator(validators[0].address, consts.MIN_VALIDATOR_TOKENS, consts.COMMISSION_RATE)
    ).to.be.revertedWith('Signer is other validator');
  });

  it('should fail to initialize a validator using a signer being used by another validator', async function () {
    await expect(
      staking
        .connect(validators[1])
        .initializeValidator(signers[0].address, consts.MIN_VALIDATOR_TOKENS, consts.COMMISSION_RATE)
    ).to.be.revertedWith('Signer already used');
  });

  it('should be able to bond validator using signer address', async function () {
    await expect(staking.connect(signers[0]).bondValidator())
      .to.emit(staking, 'ValidatorStatusUpdate')
      .withArgs(validators[0].address, consts.STATUS_BONDED);
  });

  it('should update sgn address using signer address', async function () {
    const sgnAddr = keccak256(['string'], ['sgnaddr1']);
    await expect(sgn.connect(signers[0]).updateSgnAddr(sgnAddr))
      .to.emit(sgn, 'SgnAddrUpdate')
      .withArgs(validators[0].address, '0x', sgnAddr)
      .to.emit(staking, 'ValidatorNotice')
      .withArgs(validators[0].address, 'sgn-addr', sgnAddr, sgn.address);
  });

  describe('after both validators are bonded', async () => {
    beforeEach(async () => {
      await staking
        .connect(validators[1])
        .initializeValidator(signers[1].address, consts.MIN_VALIDATOR_TOKENS, consts.COMMISSION_RATE);
      await staking.connect(validators[0]).bondValidator();
      await staking.connect(validators[1]).bondValidator();
    });

    it('should update signer correctly', async function () {
      let data = abiCoder.encode(['address'], [admin.address]);

      await expect(staking.connect(validators[0]).updateValidatorSigner(admin.address))
        .to.emit(staking, 'ValidatorNotice')
        .withArgs(validators[0].address, 'signer', data, consts.ZERO_ADDR);

      data = abiCoder.encode(['address'], [validators[0].address]);
      await expect(staking.connect(validators[0]).updateValidatorSigner(validators[0].address))
        .to.emit(staking, 'ValidatorNotice')
        .withArgs(validators[0].address, 'signer', data, consts.ZERO_ADDR);
    });

    it('should fail to update signer with invalid inputs', async function () {
      await expect(staking.connect(validators[0]).updateValidatorSigner(signers[0].address)).to.be.revertedWith(
        'Signer already used'
      );
      await expect(staking.connect(validators[0]).updateValidatorSigner(signers[1].address)).to.be.revertedWith(
        'Signer already used'
      );
      await expect(staking.connect(validators[0]).updateValidatorSigner(validators[1].address)).to.be.revertedWith(
        'Signer is other validator'
      );
    });
  });
});
