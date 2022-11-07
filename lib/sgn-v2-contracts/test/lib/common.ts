import { Fixture } from 'ethereum-waffle/dist/esm';
import { ethers, waffle } from 'hardhat';

import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import {
  Bridge,
  Bridge__factory,
  DummySwap__factory,
  FarmingRewards,
  FarmingRewards__factory,
  Govern,
  Govern__factory,
  GovernedOwnerProxy,
  GovernedOwnerProxy__factory,
  MessageBus,
  MessageBus__factory,
  MsgTest,
  MsgTest__factory,
  PeggedTokenBridge,
  PeggedTokenBridge__factory,
  SGN,
  SGN__factory,
  SimpleGovernance,
  SimpleGovernance__factory,
  SingleBridgeToken,
  SingleBridgeToken__factory,
  Staking,
  Staking__factory,
  StakingReward,
  StakingReward__factory,
  TestERC20,
  TestERC20__factory,
  TransferSwap,
  TransferSwap__factory,
  Viewer,
  Viewer__factory,
  WETH,
  WETH__factory
} from '../../typechain';
import { DummySwap } from '../../typechain/DummySwap';
import * as consts from './constants';

// Workaround for https://github.com/nomiclabs/hardhat/issues/849
// TODO: Remove once fixed upstream.
export function loadFixture<T>(fixture: Fixture<T>): Promise<T> {
  const provider = waffle.provider;
  return waffle.createFixtureLoader(provider.getWallets(), provider)(fixture);
}

interface DeploymentInfo {
  staking: Staking;
  sgn: SGN;
  stakingReward: StakingReward;
  farmingRewards: FarmingRewards;
  govern: Govern;
  viewer: Viewer;
  celr: TestERC20;
}

export async function deployContracts(admin: Wallet): Promise<DeploymentInfo> {
  const testERC20Factory = (await ethers.getContractFactory('TestERC20')) as TestERC20__factory;
  const celr = await testERC20Factory.connect(admin).deploy();
  await celr.deployed();

  const stakingFactory = (await ethers.getContractFactory('Staking')) as Staking__factory;
  const staking = await stakingFactory
    .connect(admin)
    .deploy(
      celr.address,
      consts.PROPOSAL_DEPOSIT,
      consts.VOTING_PERIOD,
      consts.UNBONDING_PERIOD,
      consts.MAX_VALIDATOR_NUM,
      consts.MIN_VALIDATOR_TOKENS,
      consts.MIN_SELF_DELEGATION,
      consts.ADVANCE_NOTICE_PERIOD,
      consts.VALIDATOR_BOND_INTERVAL,
      consts.MAX_SLASH_FACTOR
    );
  await staking.deployed();

  const sgnFactory = (await ethers.getContractFactory('SGN')) as SGN__factory;
  const sgn = await sgnFactory.connect(admin).deploy(staking.address);
  await sgn.deployed();

  const stakingRewardFactory = (await ethers.getContractFactory('StakingReward')) as StakingReward__factory;
  const stakingReward = await stakingRewardFactory.connect(admin).deploy(staking.address);
  await stakingReward.deployed();

  const farmingRewardsFactory = (await ethers.getContractFactory('FarmingRewards')) as FarmingRewards__factory;
  const farmingRewards = await farmingRewardsFactory.connect(admin).deploy(staking.address);
  await farmingRewards.deployed();

  const governFactory = (await ethers.getContractFactory('Govern')) as Govern__factory;
  const govern = await governFactory.connect(admin).deploy(staking.address, celr.address, stakingReward.address);
  await govern.deployed();

  const viewerFactory = (await ethers.getContractFactory('Viewer')) as Viewer__factory;
  const viewer = await viewerFactory.connect(admin).deploy(staking.address);
  await viewer.deployed();

  return { staking, sgn, stakingReward, farmingRewards, govern, viewer, celr };
}

interface BridgeInfo {
  bridge: Bridge;
  token: TestERC20;
  pegBridge: PeggedTokenBridge;
  pegToken: SingleBridgeToken;
}

export async function deployBridgeContracts(admin: Wallet): Promise<BridgeInfo> {
  const testERC20Factory = (await ethers.getContractFactory('TestERC20')) as TestERC20__factory;
  const token = await testERC20Factory.connect(admin).deploy();
  await token.deployed();

  const bridgeFactory = (await ethers.getContractFactory('Bridge')) as Bridge__factory;
  const bridge = await bridgeFactory.connect(admin).deploy();
  await bridge.deployed();

  const pegBridgeFactory = (await ethers.getContractFactory('PeggedTokenBridge')) as PeggedTokenBridge__factory;
  const pegBridge = await pegBridgeFactory.connect(admin).deploy(bridge.address);
  await pegBridge.deployed();

  const pegTokenFactory = (await ethers.getContractFactory('SingleBridgeToken')) as SingleBridgeToken__factory;
  const pegToken = await pegTokenFactory.connect(admin).deploy('PegToken', 'PGT', 18, pegBridge.address);
  await pegToken.deployed();

  return { bridge, token, pegBridge, pegToken };
}

interface MessageInfo {
  bridge: Bridge;
  msgbus: MessageBus;
  msgtest: MsgTest;
  token: TestERC20;
}

export async function deployMessageContracts(admin: Wallet): Promise<MessageInfo> {
  const testERC20Factory = (await ethers.getContractFactory('TestERC20')) as TestERC20__factory;
  const token = await testERC20Factory.connect(admin).deploy();
  await token.deployed();

  const bridgeFactory = (await ethers.getContractFactory('Bridge')) as Bridge__factory;
  const bridge = await bridgeFactory.connect(admin).deploy();
  await bridge.deployed();

  const msgbusFactory = (await ethers.getContractFactory('MessageBus')) as MessageBus__factory;
  const msgbus = await msgbusFactory
    .connect(admin)
    .deploy(
      bridge.address,
      bridge.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero
    );
  await msgbus.deployed();

  const msgtestFactory = (await ethers.getContractFactory('MsgTest')) as MsgTest__factory;
  const msgtest = await msgtestFactory.connect(admin).deploy(msgbus.address);
  await msgtest.deployed();

  return { bridge, msgbus, msgtest, token };
}

interface GovernedOwnerInfo {
  gov: SimpleGovernance;
  proxy: GovernedOwnerProxy;
}

export async function deployGovernedOwner(admin: Wallet, initVoterNum: number): Promise<GovernedOwnerInfo> {
  const proxyFactory = (await ethers.getContractFactory('GovernedOwnerProxy')) as GovernedOwnerProxy__factory;
  const proxy = await proxyFactory.connect(admin).deploy(admin.address);
  await proxy.deployed();

  const voters: string[] = [];
  const powers: number[] = [];
  for (let i = 0; i < initVoterNum; i++) {
    const voter = new ethers.Wallet(consts.userPrivKeys[i]).connect(ethers.provider);
    voters.push(voter.address);
    powers.push(100);
  }

  const govFactory = (await ethers.getContractFactory('SimpleGovernance')) as SimpleGovernance__factory;
  const gov = await govFactory.connect(admin).deploy(voters, powers, [proxy.address], 3600, 60, 40);
  await gov.deployed();

  await proxy.initGov(gov.address);

  return { gov, proxy };
}

interface SwapInfo {
  transferSwap: TransferSwap;
  tokenA: TestERC20;
  tokenB: TestERC20;
  bridge: Bridge;
  swap: DummySwap;
  weth: WETH;
}

export async function deploySwapContracts(admin: Wallet): Promise<SwapInfo> {
  const testERC20FactoryA = (await ethers.getContractFactory('TestERC20')) as TestERC20__factory;
  const tokenA = await testERC20FactoryA.connect(admin).deploy();
  await tokenA.deployed();

  const testERC20FactoryB = (await ethers.getContractFactory('TestERC20')) as TestERC20__factory;
  const tokenB = await testERC20FactoryB.connect(admin).deploy();
  await tokenB.deployed();

  const bridgeFactory = (await ethers.getContractFactory('Bridge')) as Bridge__factory;
  const bridge = await bridgeFactory.connect(admin).deploy();
  await bridge.deployed();

  const busFactory = (await ethers.getContractFactory('MessageBus')) as MessageBus__factory;
  const bus = await busFactory
    .connect(admin)
    .deploy(
      bridge.address,
      bridge.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero
    );
  await bus.deployed();

  const swapFactory = (await ethers.getContractFactory('DummySwap')) as DummySwap__factory;
  const swap = await swapFactory.connect(admin).deploy(parseUnits('5')); // 5% fixed fake slippage
  await swap.deployed();

  const wethFactory = (await ethers.getContractFactory('WETH')) as WETH__factory;
  const weth = await wethFactory.connect(admin).deploy();
  await weth.deployed();

  const transferSwapFactory = (await ethers.getContractFactory('TransferSwap')) as TransferSwap__factory;
  const transferSwap = await transferSwapFactory.connect(admin).deploy(bus.address, swap.address, weth.address);
  await transferSwap.deployed();

  return { tokenA, tokenB, transferSwap, swap, bridge, weth };
}

export async function getAccounts(admin: Wallet, assets: TestERC20[], num: number): Promise<Wallet[]> {
  const accounts: Wallet[] = [];
  for (let i = 0; i < num; i++) {
    accounts.push(new ethers.Wallet(consts.userPrivKeys[i]).connect(ethers.provider));
    await admin.sendTransaction({
      to: accounts[i].address,
      value: parseUnits('10')
    });
    for (let j = 0; j < assets.length; j++) {
      await assets[j].transfer(accounts[i].address, parseUnits('1000'));
    }
  }
  accounts.sort((a, b) => (a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1));
  return accounts;
}

export async function advanceBlockNumber(blkNum: number): Promise<void> {
  const promises = [];
  for (let i = 0; i < blkNum; i++) {
    promises.push(ethers.provider.send('evm_mine', []));
  }
  await Promise.all(promises);
}

export async function advanceBlockNumberTo(target: number): Promise<void> {
  const blockNumber = await ethers.provider.getBlockNumber();
  const promises = [];
  for (let i = blockNumber; i < target; i++) {
    promises.push(ethers.provider.send('evm_mine', []));
  }
  await Promise.all(promises);
}

export async function getBlockTime() {
  const blockNumber = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNumber);
  return block.timestamp;
}

export async function advanceBlockTime(blkTime: number) {
  const currBlkTime = await getBlockTime();
  await ethers.provider.send('evm_setNextBlockTimestamp', [currBlkTime + blkTime]);
  await ethers.provider.send('evm_mine', []);
}

export function getAddrs(signers: Wallet[]) {
  const addrs: string[] = [];
  for (let i = 0; i < signers.length; i++) {
    addrs.push(signers[i].address);
  }
  return addrs;
}
