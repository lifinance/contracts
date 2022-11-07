import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { parseUnits } from 'ethers/lib/utils';
import { ethers } from 'hardhat';
import { Address } from 'hardhat-deploy/types';

import { keccak256 } from '@ethersproject/solidity';
import { Wallet } from '@ethersproject/wallet';

import { Bridge, DummySwap, TestERC20, TransferSwap, WETH } from '../typechain';
import { deploySwapContracts, getAccounts, loadFixture } from './lib/common';
import { ZERO_ADDR } from './lib/constants';

const UINT64_MAX = '9223372036854775807';

async function swapFixture([admin]: Wallet[]) {
  const res = await deploySwapContracts(admin);
  return { admin, ...res };
}

function computeId(sender: string, srcChainId: number, dstChainId: number, message: string) {
  return keccak256(['address', 'uint64', 'uint64', 'bytes'], [sender, srcChainId, dstChainId, message]);
}

function computeDirectSwapId(sender: string, srcChainId: number, receiver: Address, nonce: number, swap: Swap) {
  const swapStruct = [swap.path, swap.dex, swap.deadline, swap.minRecvAmt];
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint64', 'address', 'uint64', '(address[], address, uint256, uint256)'],
    [sender, srcChainId, receiver, nonce, swapStruct]
  );
  return keccak256(['bytes'], [encoded]);
}

function encodeMessage(
  dstSwap: { dex: string; path: string[]; deadline: BigNumber; minRecvAmt: BigNumber },
  receiver: string,
  nonce: number,
  nativeOut: boolean
) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['((address[], address , uint256, uint256), address, uint64, bool)'],
    [[[dstSwap.path, dstSwap.dex, dstSwap.deadline, dstSwap.minRecvAmt], receiver, nonce, nativeOut]]
  );
  return encoded;
}

function slip(amount: BigNumber, perc: number) {
  const percent = 100 - perc;
  return amount.mul(parseUnits(percent.toString(), 4)).div(parseUnits('100', 4));
}

let tokenA: TestERC20;
let tokenB: TestERC20;
let xswap: TransferSwap;
let dex: DummySwap;
let bridge: Bridge;
let accounts: Wallet[];
let admin: Wallet;
let chainId: number;
let sender: Wallet;
let receiver: Wallet;
let weth: WETH;

let amountIn: BigNumber;
const maxBridgeSlippage = parseUnits('100', 4); // 100%
const expectNonce = 1;

interface Swap {
  dex: string;
  path: string[];
  deadline: BigNumber;
  minRecvAmt: BigNumber;
}
let srcSwap: Swap;
let dstSwap: Swap;

async function prepare() {
  const res = await loadFixture(swapFixture);
  admin = res.admin;
  tokenA = res.tokenA;
  tokenB = res.tokenB;
  weth = res.weth;
  xswap = res.transferSwap;
  dex = res.swap;
  bridge = res.bridge;
  accounts = await getAccounts(res.admin, [tokenA, tokenB], 4);
  chainId = (await ethers.provider.getNetwork()).chainId;
  sender = accounts[0];
  receiver = accounts[1];
  amountIn = parseUnits('100');

  srcSwap = {
    dex: dex.address,
    path: [] as string[],
    deadline: BigNumber.from(UINT64_MAX),
    minRecvAmt: slip(amountIn, 10)
  };
  dstSwap = {
    dex: dex.address,
    path: [tokenA.address, tokenB.address],
    deadline: BigNumber.from(UINT64_MAX),
    minRecvAmt: slip(amountIn, 10)
  };

  await xswap.setMinSwapAmount(tokenA.address, parseUnits('10'));
  await xswap.setSupportedDex(dex.address, true);

  await dex.setFakeSlippage(parseUnits('5', 4));

  await tokenA.connect(res.admin).transfer(dex.address, parseUnits('1000'));
  await tokenB.connect(res.admin).transfer(dex.address, parseUnits('1000'));
  await weth.connect(res.admin).deposit({ value: parseUnits('100') });
  await weth.connect(res.admin).transfer(dex.address, parseUnits('100'));
  return { admin, tokenA, tokenB, xswap, dex, bridge, accounts, chainId };
}

describe('Test transferWithSwap', function () {
  let srcChainId: number;
  const dstChainId = 2; // doesn't matter

  beforeEach(async () => {
    await prepare();
    srcChainId = chainId;
  });

  it('should revert if paths are empty', async function () {
    srcSwap.path = [];
    dstSwap.path = [tokenA.address, tokenB.address];
    await tokenA.connect(sender).approve(xswap.address, amountIn);
    await expect(
      xswap
        .connect(sender)
        .transferWithSwap(receiver.address, amountIn, dstChainId, srcSwap, dstSwap, maxBridgeSlippage, 1)
    ).to.be.reverted;
  });

  it('should revert if min swap amount is not satisfied', async function () {
    amountIn = parseUnits('5');
    srcSwap.path = [tokenA.address, tokenB.address];
    dstSwap.path = [tokenB.address, tokenA.address];
    await tokenA.connect(sender).approve(xswap.address, amountIn);
    await expect(
      xswap
        .connect(sender)
        .transferWithSwap(receiver.address, amountIn, dstChainId, srcSwap, dstSwap, maxBridgeSlippage, 1)
    ).to.be.revertedWith('amount must be greater than min swap amount');
  });

  it('should swap and send', async function () {
    srcSwap.path = [tokenA.address, tokenB.address];
    dstSwap.path = [tokenB.address, tokenA.address];

    await tokenA.connect(sender).approve(xswap.address, amountIn);
    const tx = await xswap
      .connect(sender)
      .transferWithSwap(receiver.address, amountIn, dstChainId, srcSwap, dstSwap, maxBridgeSlippage, 1);
    const message = encodeMessage(dstSwap, sender.address, expectNonce, false);
    const expectId = computeId(sender.address, srcChainId, dstChainId, message);

    await expect(tx)
      .to.emit(xswap, 'SwapRequestSent')
      .withArgs(expectId, dstChainId, amountIn, srcSwap.path[0], dstSwap.path[1]);

    const expectedSendAmt = slip(amountIn, 5);
    const srcXferId = keccak256(
      ['address', 'address', 'address', 'uint256', 'uint64', 'uint64', 'uint64'],
      [xswap.address, receiver.address, tokenB.address, expectedSendAmt, dstChainId, expectNonce, srcChainId]
    );
    await expect(tx)
      .to.emit(bridge, 'Send')
      .withArgs(
        srcXferId,
        xswap.address,
        receiver.address,
        tokenB.address,
        expectedSendAmt,
        dstChainId,
        expectNonce,
        maxBridgeSlippage
      );
  });

  it('should directly send', async function () {
    srcSwap.path = [tokenB.address];
    dstSwap.path = [tokenB.address, tokenA.address];

    await tokenB.connect(sender).approve(xswap.address, amountIn);
    const tx = await xswap
      .connect(sender)
      .transferWithSwap(receiver.address, amountIn, dstChainId, srcSwap, dstSwap, maxBridgeSlippage, 1);
    const message = encodeMessage(dstSwap, sender.address, expectNonce, false);
    const id = computeId(sender.address, srcChainId, dstChainId, message);

    await expect(tx)
      .to.emit(xswap, 'SwapRequestSent')
      .withArgs(id, dstChainId, amountIn, srcSwap.path[0], dstSwap.path[1]);

    const srcXferId = keccak256(
      ['address', 'address', 'address', 'uint256', 'uint64', 'uint64', 'uint64'],
      [xswap.address, receiver.address, tokenB.address, amountIn, dstChainId, expectNonce, srcChainId]
    );
    await expect(tx)
      .to.emit(bridge, 'Send')
      .withArgs(
        srcXferId,
        xswap.address,
        receiver.address,
        tokenB.address,
        amountIn,
        dstChainId,
        expectNonce,
        maxBridgeSlippage
      );
  });

  it('should directly swap', async function () {
    srcSwap.path = [tokenA.address, tokenB.address];
    dstSwap.path = [];

    await tokenA.connect(sender).approve(xswap.address, amountIn);
    const recvBalBefore = await tokenB.connect(receiver).balanceOf(receiver.address);
    const tx = await xswap
      .connect(sender)
      .transferWithSwap(receiver.address, amountIn, chainId, srcSwap, dstSwap, maxBridgeSlippage, 1);
    const recvBalAfter = await tokenB.connect(receiver).balanceOf(receiver.address);
    const expectId = computeDirectSwapId(sender.address, srcChainId, receiver.address, expectNonce, srcSwap);

    await expect(tx).to.not.emit(xswap, 'SwapRequestSent');
    await expect(tx).to.not.emit(bridge, 'Send');
    await expect(tx)
      .to.emit(xswap, 'DirectSwap')
      .withArgs(expectId, chainId, amountIn, tokenA.address, slip(amountIn, 5), tokenB.address);
    expect(recvBalAfter).equal(recvBalBefore.add(slip(amountIn, 5)));
  });

  it('should revert if the tx results in a noop', async function () {
    srcSwap.path = [tokenA.address];
    dstSwap.path = [];

    await tokenA.connect(sender).approve(xswap.address, amountIn);
    await expect(
      xswap
        .connect(sender)
        .transferWithSwap(receiver.address, amountIn, chainId, srcSwap, dstSwap, maxBridgeSlippage, 1)
    ).to.be.revertedWith('noop is not allowed');
  });
});

describe('Test transferWithSwapNative', function () {
  let srcChainId: number;
  const dstChainId = 2; // doesn't matter

  const amountIn2 = parseUnits('10');

  beforeEach(async () => {
    await prepare();
    srcChainId = chainId;
  });

  it('should revert if native in does not match amountIn (native in)', async function () {
    srcSwap.path = [weth.address, tokenB.address];
    dstSwap.path = [tokenB.address, weth.address];

    await expect(
      xswap
        .connect(sender)
        .transferWithSwapNative(receiver.address, amountIn2, dstChainId, srcSwap, dstSwap, maxBridgeSlippage, 1, true, {
          value: amountIn2.div(2)
        })
    ).to.be.revertedWith('Amount insufficient');
  });

  it('should swap and send (native in)', async function () {
    srcSwap.path = [weth.address, tokenB.address];
    srcSwap.minRecvAmt = slip(amountIn2, 10);
    dstSwap.path = [tokenB.address, weth.address];
    dstSwap.minRecvAmt = slip(amountIn2, 10);

    const balBefore = await sender.getBalance();
    const tx = await xswap
      .connect(sender)
      .transferWithSwapNative(receiver.address, amountIn2, dstChainId, srcSwap, dstSwap, maxBridgeSlippage, 1, true, {
        value: amountIn2
      });

    const balAfter = await sender.getBalance();
    expect(balAfter.lte(balBefore.sub(amountIn2)));
    const message = encodeMessage(dstSwap, sender.address, expectNonce, true);
    const expectId = computeId(sender.address, srcChainId, dstChainId, message);

    await expect(tx)
      .to.emit(xswap, 'SwapRequestSent')
      .withArgs(expectId, dstChainId, amountIn2, srcSwap.path[0], dstSwap.path[1]);

    const expectedSendAmt = slip(amountIn2, 5);
    const srcXferId = keccak256(
      ['address', 'address', 'address', 'uint256', 'uint64', 'uint64', 'uint64'],
      [xswap.address, receiver.address, tokenB.address, expectedSendAmt, dstChainId, expectNonce, srcChainId]
    );
    await expect(tx)
      .to.emit(bridge, 'Send')
      .withArgs(
        srcXferId,
        xswap.address,
        receiver.address,
        tokenB.address,
        expectedSendAmt,
        dstChainId,
        expectNonce,
        maxBridgeSlippage
      );
  });
});

describe('Test executeMessageWithTransfer', function () {
  beforeEach(async () => {
    await prepare();
    // impersonate MessageBus as admin to gain access to calling executeMessageWithTransfer
    await xswap.connect(admin).setMessageBus(admin.address);
  });

  const srcChainId = 1;

  it('should swap', async function () {
    dstSwap.path = [tokenA.address, tokenB.address];
    const message = encodeMessage(dstSwap, receiver.address, expectNonce, false);

    const balB1 = await tokenB.connect(admin).balanceOf(receiver.address);
    await tokenA.connect(admin).transfer(xswap.address, amountIn);
    const tx = await xswap
      .connect(admin)
      .executeMessageWithTransfer(ZERO_ADDR, tokenA.address, amountIn, srcChainId, message, ZERO_ADDR);
    const balB2 = await tokenB.connect(admin).balanceOf(receiver.address);
    const id = computeId(receiver.address, srcChainId, chainId, message);
    const dstAmount = slip(amountIn, 5);
    const expectStatus = 1; // SwapStatus.Succeeded
    await expect(tx).to.emit(xswap, 'SwapRequestDone').withArgs(id, dstAmount, expectStatus);
    expect(balB2).to.equal(balB1.add(dstAmount));
  });

  it('should swap and send native', async function () {
    dstSwap.path = [tokenA.address, weth.address];
    const amountIn2 = parseUnits('10');
    dstSwap.minRecvAmt = slip(amountIn2, 10);
    const message = encodeMessage(dstSwap, receiver.address, expectNonce, true);
    const bal1 = await receiver.getBalance();
    await tokenA.connect(admin).transfer(xswap.address, amountIn2);
    const tx = await xswap
      .connect(admin)
      .executeMessageWithTransfer(ZERO_ADDR, tokenA.address, amountIn2, srcChainId, message, ZERO_ADDR);
    const bal2 = await receiver.getBalance();
    const id = computeId(receiver.address, srcChainId, chainId, message);
    const dstAmount = slip(amountIn2, 5);
    const expectStatus = 1; // SwapStatus.Succeeded
    await expect(tx).to.emit(xswap, 'SwapRequestDone').withArgs(id, dstAmount, expectStatus);
    expect(bal2.eq(bal1.add(dstAmount)));
  });

  it('should send bridge token to receiver if no dst swap specified', async function () {
    dstSwap.path = [tokenA.address];
    const message = encodeMessage(dstSwap, receiver.address, expectNonce, false);
    await tokenA.connect(admin).transfer(xswap.address, amountIn);

    const balA1 = await tokenA.connect(receiver).balanceOf(receiver.address);
    const tx = await xswap
      .connect(admin)
      .executeMessageWithTransfer(ZERO_ADDR, tokenA.address, amountIn, srcChainId, message, ZERO_ADDR);
    const balA2 = await tokenA.connect(receiver).balanceOf(receiver.address);
    const id = computeId(receiver.address, srcChainId, chainId, message);
    const expectStatus = 1; // SwapStatus.Succeeded
    await expect(tx).to.emit(xswap, 'SwapRequestDone').withArgs(id, amountIn, expectStatus);
    expect(balA2).to.equal(balA1.add(amountIn));
  });

  it('should send bridge token to receiver if swap fails on dst chain', async function () {
    srcSwap.path = [tokenA.address, tokenB.address];
    dstSwap.path = [tokenB.address, tokenA.address];
    const bridgeAmount = slip(amountIn, 5);
    dstSwap.minRecvAmt = bridgeAmount; // dst chain swap should fail due to slippage
    const msg = encodeMessage(dstSwap, receiver.address, expectNonce, false);
    const balA1 = await tokenA.balanceOf(receiver.address);
    const balB1 = await tokenB.balanceOf(receiver.address);
    await tokenB.connect(admin).transfer(xswap.address, bridgeAmount);
    const tx = xswap
      .connect(admin)
      .executeMessageWithTransfer(ZERO_ADDR, tokenB.address, bridgeAmount, srcChainId, msg, ZERO_ADDR);
    const expectId = computeId(receiver.address, srcChainId, chainId, msg);
    const expectStatus = 3; // SwapStatus.Fallback
    await expect(tx).to.emit(xswap, 'SwapRequestDone').withArgs(expectId, slip(amountIn, 5), expectStatus);
    const balA2 = await tokenA.balanceOf(receiver.address);
    const balB2 = await tokenB.balanceOf(receiver.address);
    expect(balA2, 'balance A after').equals(balA1);
    expect(balB2, 'balance B after').equals(balB1.add(bridgeAmount));
  });
});
