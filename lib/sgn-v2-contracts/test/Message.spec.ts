import { expect } from 'chai';
import { ethers } from 'hardhat';

import { BigNumber } from '@ethersproject/bignumber';
import { keccak256, pack } from '@ethersproject/solidity';
import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { Bridge, TestERC20, MessageBus, MsgTest } from '../typechain';
import { deployMessageContracts, loadFixture } from './lib/common';
import { calculateSignatures, hex2Bytes, getRelayRequest } from './lib/proto';
import * as consts from './lib/constants';

type RouteInfoStruct = {
  sender: string;
  receiver: string;
  srcChainId: number;
  srcTxHash: string;
};

type RouteInfo2Struct = {
  sender: number[];
  receiver: string;
  srcChainId: number;
  srcTxHash: string;
};

describe('Message Tests', function () {
  async function fixture([admin]: Wallet[]) {
    const { bridge, msgbus, msgtest, token } = await deployMessageContracts(admin);
    await bridge.resetSigners([admin.address], [parseUnits('1')]);
    return { admin, bridge, msgbus, msgtest, token };
  }

  let admin: Wallet;
  let bridge: Bridge;
  let msgbus: MessageBus;
  let msgtest: MsgTest;
  let token: TestERC20;
  let chainId: number;

  beforeEach(async () => {
    const res = await loadFixture(fixture);
    admin = res.admin;
    bridge = res.bridge;
    token = res.token;
    msgbus = res.msgbus;
    msgtest = res.msgtest;
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  it('should execute msg correctly', async function () {
    const hash = keccak256(['string'], ['hello']);
    const srcChainId = 5;
    const routeInfo = {
      sender: admin.address,
      receiver: msgtest.address,
      srcChainId: srcChainId,
      srcTxHash: hash // fake tx hash
    };
    let nonce = 1;
    let message = ethers.utils.defaultAbiCoder.encode(['uint64', 'bytes'], [nonce, hash]);
    let res = await computeMessageIdAndSigs(chainId, msgbus.address, routeInfo, message, [admin]);
    await expect(
      msgbus.functions['executeMessage(bytes,(address,address,uint64,bytes32),bytes[],address[],uint256[])'](
        message,
        routeInfo,
        res.sigs,
        [admin.address],
        [parseUnits('1')]
      )
    )
      .to.emit(msgtest, 'MessageReceived')
      .withArgs(admin.address, srcChainId, nonce, hash)
      .to.emit(msgbus, 'Executed')
      .withArgs(consts.TYPE_MSG_ONLY, res.messageId, consts.MSG_TX_SUCCESS, msgtest.address, srcChainId, hash);

    const routeInfo2 = {
      sender: hex2Bytes(admin.address),
      receiver: msgtest.address,
      srcChainId: srcChainId,
      srcTxHash: hash // fake tx hash
    };
    nonce = 2;
    message = ethers.utils.defaultAbiCoder.encode(['uint64', 'bytes'], [nonce, hash]);
    res = await computeMessage2IdAndSigs(chainId, msgbus.address, routeInfo2, message, [admin]);
    await expect(
      msgbus.functions['executeMessage(bytes,(bytes,address,uint64,bytes32),bytes[],address[],uint256[])'](
        message,
        routeInfo2,
        res.sigs,
        [admin.address],
        [parseUnits('1')]
      )
    )
      .to.emit(msgtest, 'Message2Received')
      .withArgs(pack(['address'], [admin.address]), srcChainId, nonce, hash)
      .to.emit(msgbus, 'Executed')
      .withArgs(consts.TYPE_MSG_ONLY, res.messageId, consts.MSG_TX_SUCCESS, msgtest.address, srcChainId, hash);

    nonce = 100000000000001;
    message = ethers.utils.defaultAbiCoder.encode(['uint64', 'bytes'], [nonce, hash]);
    res = await computeMessageIdAndSigs(chainId, msgbus.address, routeInfo, message, [admin]);
    await expect(
      msgbus.functions['executeMessage(bytes,(address,address,uint64,bytes32),bytes[],address[],uint256[])'](
        message,
        routeInfo,
        res.sigs,
        [admin.address],
        [parseUnits('1')]
      )
    )
      .to.emit(msgbus, 'CallReverted')
      .withArgs('invalid nonce')
      .to.emit(msgbus, 'Executed')
      .withArgs(consts.TYPE_MSG_ONLY, res.messageId, consts.MSG_TX_FAIL, msgtest.address, srcChainId, hash);

    nonce = 100000000000002;
    message = ethers.utils.defaultAbiCoder.encode(['uint64', 'bytes'], [nonce, hash]);
    res = await computeMessageIdAndSigs(chainId, msgbus.address, routeInfo, message, [admin]);
    await expect(
      msgbus.functions['executeMessage(bytes,(address,address,uint64,bytes32),bytes[],address[],uint256[])'](
        message,
        routeInfo,
        res.sigs,
        [admin.address],
        [parseUnits('1')]
      )
    )
      .to.emit(msgbus, 'CallReverted')
      .withArgs('Transaction reverted silently')
      .to.emit(msgbus, 'Executed')
      .withArgs(consts.TYPE_MSG_ONLY, res.messageId, consts.MSG_TX_FAIL, msgtest.address, srcChainId, hash);
  });

  it('should execute msg with transfer correctly', async function () {
    await token.approve(bridge.address, parseUnits('100'));
    await bridge.addLiquidity(token.address, parseUnits('50'));
    const hash = keccak256(['string'], ['hello']);
    const amount = parseUnits('1');
    const srcChainId = 5;
    const message = ethers.utils.defaultAbiCoder.encode(['address', 'bytes'], [admin.address, hash]);
    let res = await getMessageWithTransferRequest(
      chainId,
      msgbus.address,
      bridge.address,
      admin.address,
      msgtest.address,
      token.address,
      amount,
      srcChainId,
      hash, // fake src transfer Id
      hash, // fake src srcTxHash
      message,
      admin,
      parseUnits('1')
    );
    await expect(msgbus.transferAndExecuteMsg(res.bridgeTransferParams, res.executionParams))
      .to.emit(msgbus, 'Executed')
      .withArgs(consts.TYPE_MSG_XFER, res.messageId, consts.MSG_TX_SUCCESS, msgtest.address, srcChainId, hash)
      .to.emit(msgtest, 'MessageReceivedWithTransfer')
      .withArgs(token.address, amount, admin.address, srcChainId, admin.address, hash);

    await expect(
      msgbus.executeMessageWithTransfer(
        message,
        res.executionParams.transfer,
        res.executionParams.sigs,
        res.executionParams.signers,
        res.executionParams.powers
      )
    ).to.be.revertedWith('transfer already executed');
  });
});

async function computeMessageIdAndSigs(
  chainId: number,
  msgbus: string,
  route: RouteInfoStruct,
  message: string,
  signers: Wallet[]
) {
  const messageId = keccak256(
    ['uint8', 'address', 'address', 'uint64', 'bytes32', 'uint64', 'bytes'],
    [consts.TYPE_MSG_ONLY, route.sender, route.receiver, route.srcChainId, route.srcTxHash, chainId, message]
  );
  const domain = keccak256(['uint256', 'address', 'string'], [chainId, msgbus, 'Message']);
  const signedData = pack(['bytes32', 'bytes32'], [domain, messageId]);
  const signedDataHash = keccak256(['bytes'], [signedData]);
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));
  return { messageId, sigs };
}

async function computeMessage2IdAndSigs(
  chainId: number,
  msgbus: string,
  route: RouteInfo2Struct,
  message: string,
  signers: Wallet[]
) {
  const messageId = keccak256(
    ['uint8', 'bytes', 'address', 'uint64', 'bytes32', 'uint64', 'bytes'],
    [consts.TYPE_MSG_ONLY, route.sender, route.receiver, route.srcChainId, route.srcTxHash, chainId, message]
  );
  const domain = keccak256(['uint256', 'address', 'string'], [chainId, msgbus, 'Message2']);
  const signedData = pack(['bytes32', 'bytes32'], [domain, messageId]);
  const signedDataHash = keccak256(['bytes'], [signedData]);
  const sigs = await calculateSignatures(signers, hex2Bytes(signedDataHash));
  return { messageId, sigs };
}

async function getMessageWithTransferRequest(
  chainId: number,
  msgbus: string,
  bridge: string,
  sender: string,
  receiver: string,
  token: string,
  amount: BigNumber,
  srcChainId: number,
  refId: string,
  srcTxHash: string,
  message: string,
  signer: Wallet,
  power: BigNumber
) {
  const relayReq = await getRelayRequest(
    sender,
    receiver,
    token,
    amount,
    srcChainId,
    chainId,
    refId, // fake src transfer Id
    [signer],
    bridge
  );
  const bridgeTransferParams = {
    request: relayReq.relayBytes,
    sigs: relayReq.sigs,
    signers: [signer.address],
    powers: [power]
  };

  const xferId = keccak256(
    ['address', 'address', 'address', 'uint256', 'uint64', 'uint64', 'bytes32'],
    [sender, receiver, token, amount, srcChainId, chainId, refId]
  );
  const messageId = keccak256(['uint8', 'address', 'bytes32'], [consts.TYPE_MSG_XFER, bridge, xferId]);
  const domain = keccak256(['uint256', 'address', 'string'], [chainId, msgbus, 'MessageWithTransfer']);
  const signedData = pack(['bytes32', 'bytes32', 'bytes', 'bytes32'], [domain, messageId, message, srcTxHash]);
  const signedDataHash = keccak256(['bytes'], [signedData]);
  const sigs = await calculateSignatures([signer], hex2Bytes(signedDataHash));

  const transferInfo = {
    t: consts.XFER_TYPE_LQ_RELAY,
    sender: sender,
    receiver: receiver,
    token: token,
    amount: amount,
    wdseq: 0,
    srcChainId: srcChainId,
    refId: refId,
    srcTxHash: srcTxHash
  };

  const executionParams = {
    message: message,
    transfer: transferInfo,
    sigs: sigs,
    signers: [signer.address],
    powers: [power]
  };

  return { bridgeTransferParams, executionParams, messageId };
}
