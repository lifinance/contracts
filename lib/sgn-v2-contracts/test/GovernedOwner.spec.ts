import { ethers } from 'hardhat';
import { Wallet } from '@ethersproject/wallet';
import { keccak256 } from '@ethersproject/solidity';
import { Bridge, PeggedTokenBridge, SimpleGovernance, GovernedOwnerProxy, TestERC20 } from '../typechain';
import { deployBridgeContracts, deployGovernedOwner, getAccounts, advanceBlockTime, loadFixture } from './lib/common';
import { expect } from 'chai';
import * as consts from './lib/constants';
import { parseUnits } from 'ethers/lib/utils';

describe('GovernedOwner Tests', function () {
  const initVoterNum = 4;
  const InitFastPassThreshold = 40;
  const abiCoder = ethers.utils.defaultAbiCoder;

  async function fixture([admin]: Wallet[]) {
    const { bridge, token, pegBridge } = await deployBridgeContracts(admin);
    const { gov, proxy } = await deployGovernedOwner(admin, initVoterNum);
    return { admin, bridge, token, pegBridge, gov, proxy };
  }

  let bridge: Bridge;
  let token: TestERC20;
  let pegBridge: PeggedTokenBridge;
  let gov: SimpleGovernance;
  let proxy: GovernedOwnerProxy;
  let voters: Wallet[];

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    bridge = res.bridge;
    token = res.token;
    pegBridge = res.pegBridge;
    gov = res.gov;
    proxy = res.proxy;
    voters = await getAccounts(res.admin, [], 5);
    await bridge.transferOwnership(gov.address);
    await pegBridge.transferOwnership(gov.address);
  });

  it('should pass param change tests', async function () {
    expect(await gov.params(consts.GovParamFastPassThreshold)).to.equal(InitFastPassThreshold);

    const newThreshold = 10;
    await expect(gov.connect(voters[0]).createParamChangeProposal(consts.GovParamFastPassThreshold, newThreshold))
      .to.emit(gov, 'ParamChangeProposalCreated')
      .withArgs(0, consts.GovParamFastPassThreshold, 10);

    const data = abiCoder.encode(['uint8', 'uint256'], [consts.GovParamFastPassThreshold, 10]);
    await expect(
      gov.connect(voters[2]).executeProposal(0, consts.GovInternalParamChange, consts.ZERO_ADDR, data)
    ).to.be.revertedWith('not enough votes');

    await gov.connect(voters[1]).voteProposal(0, true);

    await expect(gov.connect(voters[2]).executeProposal(0, consts.GovInternalParamChange, consts.ZERO_ADDR, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(0);

    expect(await gov.params(consts.GovParamFastPassThreshold)).to.equal(newThreshold);
  });

  it('should pass voter and proxy update tests', async function () {
    // voter update tests
    expect((await gov.getVoters())[0]).to.deep.equal([
      voters[0].address,
      voters[1].address,
      voters[2].address,
      voters[3].address
    ]);
    await expect(gov.connect(voters[0]).createVoterUpdateProposal([voters[1].address, voters[4].address], [0, 100]))
      .to.emit(gov, 'VoterUpdateProposalCreated')
      .withArgs(0, [voters[1].address, voters[4].address], [0, 100]);

    await gov.connect(voters[1]).voteProposal(0, true);

    let data = abiCoder.encode(
      ['address[]', 'uint256[]'],
      [
        [voters[1].address, voters[4].address],
        [0, 100]
      ]
    );
    await expect(gov.connect(voters[2]).executeProposal(0, consts.GovInternalVoterUpdate, consts.ZERO_ADDR, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(0);

    expect((await gov.getVoters())[0]).to.deep.equal([
      voters[0].address,
      voters[3].address,
      voters[2].address,
      voters[4].address
    ]);
    expect(await gov.voterPowers(voters[1].address)).to.equal(0);
    expect(await gov.voterPowers(voters[4].address)).to.equal(100);

    // proxy update tests
    expect(await gov.proposerProxies(proxy.address)).to.equal(true);
    await expect(gov.connect(voters[4]).createProxyUpdateProposal([proxy.address, voters[3].address], [false, true]))
      .to.emit(gov, 'ProxyUpdateProposalCreated')
      .withArgs(1, [proxy.address, voters[3].address], [false, true]);

    await gov.connect(voters[0]).voteProposal(1, true);

    data = abiCoder.encode(
      ['address[]', 'bool[]'],
      [
        [proxy.address, voters[3].address],
        [false, true]
      ]
    );
    await expect(gov.connect(voters[2]).executeProposal(1, consts.GovInternalProxyUpdate, consts.ZERO_ADDR, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(1);

    expect(await gov.proposerProxies(proxy.address)).to.equal(false);
    expect(await gov.proposerProxies(voters[3].address)).to.equal(true);
  });

  it('should pass transfer token tests', async function () {
    expect(await token.balanceOf(voters[0].address)).to.equal(0);

    const amount = parseUnits('1');
    await token.transfer(gov.address, amount);
    await expect(gov.connect(voters[0]).createTransferTokenProposal(voters[0].address, token.address, amount))
      .to.emit(gov, 'TransferTokenProposalCreated')
      .withArgs(0, voters[0].address, token.address, amount);
    await gov.connect(voters[1]).voteProposal(0, true);
    const data = abiCoder.encode(['address', 'address', 'uint256'], [voters[0].address, token.address, amount]);
    await expect(gov.connect(voters[2]).executeProposal(0, consts.GovInternalTokenTransfer, consts.ZERO_ADDR, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(0);

    expect(await token.balanceOf(voters[0].address)).to.equal(amount);
  });

  it('should pass common owner proxy tests', async function () {
    // proposal 0: add pauser - success
    const pauser = voters[2].address;
    await expect(proxy.connect(voters[0]).proposeUpdatePauser(bridge.address, 1, pauser))
      .to.emit(proxy, 'UpdatePauserProposalCreated')
      .withArgs(0, bridge.address, 1, pauser);

    let data = (await bridge.populateTransaction.addPauser(pauser)).data || '';
    await expect(
      gov.connect(voters[3]).executeProposal(0, consts.GovExternalFastPass, bridge.address, '0x01')
    ).to.be.revertedWith('data hash not match');
    await expect(
      gov.connect(voters[3]).executeProposal(0, consts.GovExternalFastPass, voters[0].address, data)
    ).to.be.revertedWith('data hash not match');
    await expect(gov.connect(voters[3]).executeProposal(0, consts.GovExternalFastPass, bridge.address, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(0)
      .to.emit(bridge, 'PauserAdded')
      .withArgs(pauser);

    // proposal 1: remove pauser - fail due to timeout
    await expect(proxy.connect(voters[0]).proposeUpdatePauser(bridge.address, 2, pauser))
      .to.emit(proxy, 'UpdatePauserProposalCreated')
      .withArgs(1, bridge.address, 2, pauser);
    await advanceBlockTime(10000);
    data = (await bridge.populateTransaction.removePauser(pauser)).data || '';
    await expect(
      gov.connect(voters[1]).executeProposal(1, consts.GovExternalFastPass, bridge.address, data)
    ).to.be.revertedWith('deadline passed');
    await expect(gov.connect(voters[1]).voteProposal(1, true)).to.be.revertedWith('deadline passed');

    // proposal 2: transfer ownership
    expect(await bridge.owner()).to.equal(gov.address);

    const newOwner = voters[0].address;
    await expect(proxy.connect(voters[0]).proposeTransferOwnership(bridge.address, newOwner))
      .to.emit(proxy, 'TransferOwnershipProposalCreated')
      .withArgs(2, bridge.address, newOwner);

    data = (await bridge.populateTransaction.transferOwnership(newOwner)).data || '';
    await expect(
      gov.connect(voters[1]).executeProposal(2, consts.GovExternalDefault, bridge.address, data)
    ).to.be.revertedWith('not enough votes');
    await gov.connect(voters[1]).voteProposal(2, true);
    await expect(gov.voteProposal(0, true)).to.be.revertedWith('invalid voter');

    await gov.connect(voters[2]).executeProposal(2, consts.GovExternalDefault, bridge.address, data);
    expect(await bridge.owner()).to.equal(newOwner);

    await expect(
      gov.connect(voters[2]).executeProposal(2, consts.GovExternalDefault, bridge.address, data)
    ).to.be.revertedWith('deadline passed');
  });

  it('should pass bridge owner proxy tests', async function () {
    // reset signers
    await expect(proxy.connect(voters[0]).proposeResetSigners(bridge.address, [voters[0].address], [1000]))
      .to.emit(proxy, 'ResetSignersProposalCreated')
      .withArgs(0, bridge.address, [voters[0].address], [1000]);

    await gov.connect(voters[1]).voteProposal(0, true);

    let data = (await bridge.populateTransaction.resetSigners([voters[0].address], [1000])).data || '';
    await expect(gov.connect(voters[2]).executeProposal(0, consts.GovExternalDefault, bridge.address, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(0)
      .to.emit(bridge, 'SignersUpdated')
      .withArgs([voters[0].address], [1000]);

    expect(await bridge.ssHash()).to.equal(keccak256(['address[]', 'uint256[]'], [[voters[0].address], [1000]]));

    // update governor
    await expect(proxy.connect(voters[0]).proposeUpdateGovernor(bridge.address, 1, voters[0].address))
      .to.emit(proxy, 'UpdateGovernorProposalCreated')
      .withArgs(1, bridge.address, 1, voters[0].address);

    data = (await bridge.populateTransaction.addGovernor(voters[0].address)).data || '';
    await expect(gov.connect(voters[2]).executeProposal(1, consts.GovExternalFastPass, bridge.address, data))
      .to.emit(gov, 'ProposalExecuted')
      .withArgs(1)
      .to.emit(bridge, 'GovernorAdded')
      .withArgs(voters[0].address);
  });
});
