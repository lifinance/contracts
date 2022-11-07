import { expect } from 'chai';
import protobuf from 'protobufjs';

import { BigNumber } from '@ethersproject/bignumber';
import { keccak256, pack } from '@ethersproject/solidity';
import { Wallet } from '@ethersproject/wallet';

protobuf.common('google/protobuf/descriptor.proto', {});

interface Proto {
  Slash: protobuf.Type;
  StakingReward: protobuf.Type;
  FarmingRewards: protobuf.Type;
  AcctAmtPair: protobuf.Type;
  Relay: protobuf.Type;
  WithdrawMsg: protobuf.Type;
  Mint: protobuf.Type;
}

async function getProtos(): Promise<Proto> {
  const staking = await protobuf.load(`${__dirname}/../../contracts/libraries/proto/staking.proto`);
  const farming = await protobuf.load(`${__dirname}/../../contracts/libraries/proto/farming.proto`);
  const bridge = await protobuf.load(`${__dirname}/../../contracts/libraries/proto/bridge.proto`);
  const pool = await protobuf.load(`${__dirname}/../../contracts/libraries/proto/pool.proto`);
  const pegged = await protobuf.load(`${__dirname}/../../contracts/libraries/proto/pegged.proto`);

  const Slash = staking.lookupType('staking.Slash');
  const StakingReward = staking.lookupType('staking.StakingReward');
  const FarmingRewards = farming.lookupType('farming.FarmingRewards');
  const AcctAmtPair = staking.lookupType('staking.AcctAmtPair');

  const Relay = bridge.lookupType('bridge.Relay');
  const WithdrawMsg = pool.lookupType('pool.WithdrawMsg');
  const Mint = pegged.lookupType('pegged.Mint');

  return {
    Slash,
    StakingReward,
    FarmingRewards,
    AcctAmtPair,
    Relay,
    WithdrawMsg,
    Mint
  };
}

export function hex2Bytes(hexString: string): number[] {
  let hex = hexString;
  const result = [];
  if (hex.substr(0, 2) === '0x') {
    hex = hex.slice(2);
  }
  if (hex.length % 2 === 1) {
    hex = '0' + hex;
  }
  for (let i = 0; i < hex.length; i += 2) {
    result.push(parseInt(hex.substr(i, 2), 16));
  }
  return result;
}

export function uint2Bytes(x: BigNumber): number[] {
  return hex2Bytes(x.toHexString());
}

export async function calculateSignatures(signers: Wallet[], hash: number[]): Promise<number[][]> {
  const sigs = [];
  for (let i = 0; i < signers.length; i++) {
    const sig = await signers[i].signMessage(hash);
    sigs.push(hex2Bytes(sig));
  }
  return sigs;
}

export async function getStakingRewardRequest(
  recipient: string,
  cumulativeRewardAmount: BigNumber,
  signers: Wallet[],
  chainId: number,
  contractAddress: string
): Promise<{ rewardBytes: Uint8Array; sigs: number[][] }> {
  const { StakingReward } = await getProtos();
  const reward = {
    recipient: hex2Bytes(recipient),
    cumulativeRewardAmount: uint2Bytes(cumulativeRewardAmount)
  };
  const rewardProto = StakingReward.create(reward);
  const rewardBytes = StakingReward.encode(rewardProto).finish();

  const domain = keccak256(['uint256', 'address', 'string'], [chainId, contractAddress, 'StakingReward']);
  const signedData = pack(['bytes32', 'bytes'], [domain, rewardBytes]);
  const signedDataHash = keccak256(['bytes'], [signedData]);
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));

  return { rewardBytes, sigs };
}

export async function getFarmingRewardsRequest(
  recipient: string,
  tokenAddresses: string[],
  cumulativeRewardAmounts: BigNumber[],
  signers: Wallet[],
  chainId: number,
  contractAddress: string
): Promise<{ rewardBytes: Uint8Array; sigs: number[][] }> {
  const { FarmingRewards } = await getProtos();
  const reward = {
    recipient: hex2Bytes(recipient),
    tokenAddresses: tokenAddresses.map(hex2Bytes),
    cumulativeRewardAmounts: cumulativeRewardAmounts.map(uint2Bytes)
  };
  const rewardProto = FarmingRewards.create(reward);
  const rewardBytes = FarmingRewards.encode(rewardProto).finish();

  const domain = keccak256(['uint256', 'address', 'string'], [chainId, contractAddress, 'FarmingRewards']);
  const signedData = pack(['bytes32', 'bytes'], [domain, rewardBytes]);
  const signedDataHash = keccak256(['bytes'], [signedData]);
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));

  return { rewardBytes, sigs };
}

async function getAcctAmtPairs(accounts: string[], amounts: BigNumber[]): Promise<protobuf.Message[]> {
  const { AcctAmtPair } = await getProtos();
  expect(accounts.length).to.equal(amounts.length);
  const pairs = [];
  for (let i = 0; i < accounts.length; i++) {
    const pair = {
      account: hex2Bytes(accounts[i]),
      amount: uint2Bytes(amounts[i])
    };
    const pairProto = AcctAmtPair.create(pair);
    pairs.push(pairProto);
  }
  return pairs;
}

export async function getSlashRequest(
  validatorAddr: string,
  nonce: number,
  slashFactor: number,
  expireTime: number,
  jailPeriod: number,
  collectorAddrs: string[],
  collectorAmts: BigNumber[],
  signers: Wallet[],
  chainId: number,
  contractAddress: string
): Promise<{ slashBytes: Uint8Array; sigs: number[][] }> {
  const { Slash } = await getProtos();

  const collectors = await getAcctAmtPairs(collectorAddrs, collectorAmts);
  const slash = {
    validator: hex2Bytes(validatorAddr),
    nonce: nonce,
    slashFactor: slashFactor,
    expireTime: expireTime,
    jailPeriod: jailPeriod,
    collectors: collectors
  };
  const slashProto = Slash.create(slash);
  const slashBytes = Slash.encode(slashProto).finish();

  const domain = keccak256(['uint256', 'address', 'string'], [chainId, contractAddress, 'Slash']);
  const signedData = pack(['bytes32', 'bytes'], [domain, slashBytes]);
  const signedDataHash = keccak256(['bytes'], [signedData]);
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));

  return { slashBytes, sigs };
}

export async function getRelayRequest(
  sender: string,
  receiver: string,
  token: string,
  amount: BigNumber,
  srcChainId: number,
  dstChainId: number,
  srcTransferId: string,
  signers: Wallet[],
  contractAddress: string
): Promise<{ relayBytes: Uint8Array; sigs: number[][] }> {
  const { Relay } = await getProtos();
  const relay = {
    sender: hex2Bytes(sender),
    receiver: hex2Bytes(receiver),
    token: hex2Bytes(token),
    amount: uint2Bytes(amount),
    srcChainId: srcChainId,
    dstChainId: dstChainId,
    srcTransferId: hex2Bytes(srcTransferId)
  };
  const relayProto = Relay.create(relay);
  const relayBytes = Relay.encode(relayProto).finish();

  const domain = keccak256(['uint256', 'address', 'string'], [dstChainId, contractAddress, 'Relay']);
  const signedData = pack(['bytes32', 'bytes'], [domain, relayBytes]);
  const signedDataHash = keccak256(['bytes'], [signedData]);

  const signerAddrs = [];
  for (let i = 0; i < signers.length; i++) {
    signerAddrs.push(signers[i].address);
  }

  signers.sort((a, b) => (a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1));
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));

  return { relayBytes, sigs };
}

export async function getWithdrawRequest(
  chainId: number,
  seqnum: number,
  receiver: string,
  token: string,
  amount: BigNumber,
  refid: string,
  signers: Wallet[],
  contractAddress: string
): Promise<{ withdrawBytes: Uint8Array; sigs: number[][] }> {
  const { WithdrawMsg } = await getProtos();
  const withdraw = {
    chainid: chainId,
    seqnum: seqnum,
    receiver: hex2Bytes(receiver),
    token: hex2Bytes(token),
    amount: uint2Bytes(amount),
    refid: hex2Bytes(refid)
  };
  const withdrawProto = WithdrawMsg.create(withdraw);
  const withdrawBytes = WithdrawMsg.encode(withdrawProto).finish();

  const domain = keccak256(['uint256', 'address', 'string'], [chainId, contractAddress, 'WithdrawMsg']);
  const signedData = pack(['bytes32', 'bytes'], [domain, withdrawBytes]);
  const signedDataHash = keccak256(['bytes'], [signedData]);

  const signerAddrs = [];
  for (let i = 0; i < signers.length; i++) {
    signerAddrs.push(signers[i].address);
  }

  signers.sort((a, b) => (a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1));
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));
  return { withdrawBytes, sigs };
}

export async function getMintRequest(
  token: string,
  account: string,
  amount: BigNumber,
  depositor: string,
  refChainId: number,
  refId: string,
  signers: Wallet[],
  chainId: number,
  contractAddress: string
): Promise<{ mintBytes: Uint8Array; sigs: number[][] }> {
  const { Mint } = await getProtos();
  const mint = {
    token: hex2Bytes(token),
    account: hex2Bytes(account),
    amount: uint2Bytes(amount),
    depositor: hex2Bytes(depositor),
    refChainId: refChainId,
    refId: hex2Bytes(refId)
  };
  const mintProto = Mint.create(mint);
  const mintBytes = Mint.encode(mintProto).finish();

  const domain = keccak256(['uint256', 'address', 'string'], [chainId, contractAddress, 'Mint']);
  const signedData = pack(['bytes32', 'bytes'], [domain, mintBytes]);
  const signedDataHash = keccak256(['bytes'], [signedData]);

  const signerAddrs = [];
  for (let i = 0; i < signers.length; i++) {
    signerAddrs.push(signers[i].address);
  }

  signers.sort((a, b) => (a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1));
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));
  return { mintBytes, sigs };
}
