import 'hardhat-deploy';

import * as dotenv from 'dotenv';

import { Bridge__factory } from '../typechain/factories/Bridge__factory';
import { OriginalTokenVault__factory } from '../typechain/factories/OriginalTokenVault__factory';
import { PeggedTokenBridge__factory } from '../typechain/factories/PeggedTokenBridge__factory';
import { MessageBus__factory } from '../typechain/factories/MessageBus__factory';
import { RFQ__factory } from '../typechain/factories/RFQ__factory';
import { getDeployerSigner, getFeeOverrides } from './common';

dotenv.config();

async function setBridgeBasics(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const bridgeAddr = process.env.BRIDGE as string;
  if (!bridgeAddr) {
    return;
  }
  const bridge = Bridge__factory.connect(bridgeAddr, deployerSigner);
  const pausers = (process.env.BRIDGE_PAUSERS as string).split(',');
  if (pausers[0].length > 0) {
    for (let i = 0; i < pausers.length; i++) {
      const pauser = pausers[i];
      await (await bridge.addPauser(pauser, feeOverrides)).wait();
      console.log('addPauser', pauser);
    }
  }
  const governors = (process.env.BRIDGE_GOVERNORS as string).split(',');
  if (governors[0].length > 0) {
    for (let i = 0; i < governors.length; i++) {
      const governor = governors[i];
      await (await bridge.addGovernor(governor, feeOverrides)).wait();
      console.log('addGovernor', governor);
    }
  }
  const delayPeriod = process.env.BRIDGE_DELAY_PERIOD as string;
  if (delayPeriod) {
    await (await bridge.setDelayPeriod(delayPeriod, feeOverrides)).wait();
    console.log('setDelayPeriod', delayPeriod);
  }
  const epochLength = process.env.BRIDGE_EPOCH_LENGTH as string;
  if (epochLength) {
    await (await bridge.setEpochLength(epochLength, feeOverrides)).wait();
    console.log('setEpochLength', epochLength);
  }
  const minimalMaxSlippage = process.env.BRIDGE_MINIMAL_MAX_SLIPPAGE as string;
  if (minimalMaxSlippage) {
    await (await bridge.setMinimalMaxSlippage(minimalMaxSlippage, feeOverrides)).wait();
    console.log('setMinimalMaxSlippage', minimalMaxSlippage);
  }
  const weth = process.env.BRIDGE_WETH as string;
  if (weth) {
    await (await bridge.setWrap(weth, feeOverrides)).wait();
    console.log('setWrap', weth);
  }
}

async function setPeggedTokenBridgeBasics(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const peggedTokenBridgeAddr = process.env.PEGGED_TOKEN_BRIDGE as string;
  if (!peggedTokenBridgeAddr) {
    return;
  }
  const peggedTokenBridge = PeggedTokenBridge__factory.connect(peggedTokenBridgeAddr, deployerSigner);
  const pausers = (process.env.PEGGED_TOKEN_BRIDGE_PAUSERS as string).split(',');
  if (pausers[0].length > 0) {
    for (let i = 0; i < pausers.length; i++) {
      const pauser = pausers[i];
      await (await peggedTokenBridge.addPauser(pauser, feeOverrides)).wait();
      console.log('addPauser', pauser);
    }
  }
  const governors = (process.env.PEGGED_TOKEN_BRIDGE_GOVERNORS as string).split(',');
  if (governors[0].length > 0) {
    for (let i = 0; i < governors.length; i++) {
      const governor = governors[i];
      await (await peggedTokenBridge.addGovernor(governor, feeOverrides)).wait();
      console.log('addGovernor', governor);
    }
  }
  const delayPeriod = process.env.PEGGED_TOKEN_BRIDGE_DELAY_PERIOD as string;
  if (delayPeriod) {
    await (await peggedTokenBridge.setDelayPeriod(delayPeriod, feeOverrides)).wait();
    console.log('setDelayPeriod', delayPeriod);
  }
  const epochLength = process.env.PEGGED_TOKEN_BRIDGE_EPOCH_LENGTH as string;
  if (epochLength) {
    await (await peggedTokenBridge.setEpochLength(epochLength, feeOverrides)).wait();
    console.log('setEpochLength', epochLength);
  }
}

async function setOriginalTokenVaultBasics(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const originalTokenVaultAddr = process.env.ORIGINAL_TOKEN_VAULT as string;
  if (!originalTokenVaultAddr) {
    return;
  }
  const originalTokenVault = OriginalTokenVault__factory.connect(originalTokenVaultAddr, deployerSigner);
  const pausers = (process.env.ORIGINAL_TOKEN_VAULT_PAUSERS as string).split(',');
  if (pausers[0].length > 0) {
    for (let i = 0; i < pausers.length; i++) {
      const pauser = pausers[i];
      await (await originalTokenVault.addPauser(pauser, feeOverrides)).wait();
      console.log('addPauser', pauser);
    }
  }
  const governors = (process.env.ORIGINAL_TOKEN_VAULT_GOVERNORS as string).split(',');
  if (governors[0].length > 0) {
    for (let i = 0; i < governors.length; i++) {
      const governor = governors[i];
      await (await originalTokenVault.addGovernor(governor, feeOverrides)).wait();
      console.log('addGovernor', governor);
    }
  }
  const delayPeriod = process.env.ORIGINAL_TOKEN_VAULT_DELAY_PERIOD as string;
  if (delayPeriod) {
    await (await originalTokenVault.setDelayPeriod(delayPeriod, feeOverrides)).wait();
    console.log('setDelayPeriod', delayPeriod);
  }
  const epochLength = process.env.ORIGINAL_TOKEN_VAULT_EPOCH_LENGTH as string;
  if (epochLength) {
    await (await originalTokenVault.setEpochLength(epochLength, feeOverrides)).wait();
    console.log('setEpochLength', epochLength);
  }
  const weth = process.env.ORIGINAL_TOKEN_VAULT_WETH as string;
  if (weth) {
    await (await originalTokenVault.setWrap(weth, feeOverrides)).wait();
    console.log('setWrap', weth);
  }
}

async function setMessageBusBasics(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const messageBusAddr = process.env.MESSAGE_BUS as string;
  if (!messageBusAddr) {
    return;
  }
  const messageBus = MessageBus__factory.connect(messageBusAddr, deployerSigner);
  const liquidityBridge = process.env.MESSAGE_BUS_LIQUIDITY_BRIDGE as string;
  if (liquidityBridge) {
    await (await messageBus.setLiquidityBridge(liquidityBridge, feeOverrides)).wait();
    console.log('setLiquidityBridge', liquidityBridge);
  }
  const pegVault = process.env.MESSAGE_BUS_PEG_VAULT as string;
  if (pegVault) {
    await (await messageBus.setPegVault(pegVault, feeOverrides)).wait();
    console.log('setPegVault', pegVault);
  }
  const pegBridge = process.env.MESSAGE_BUS_PEG_BRIDGE as string;
  if (pegBridge) {
    await (await messageBus.setPegBridge(pegBridge, feeOverrides)).wait();
    console.log('setPegBridge', pegBridge);
  }
  const pegVaultV2 = process.env.MESSAGE_BUS_PEG_VAULT_V2 as string;
  if (pegVaultV2) {
    await (await messageBus.setPegVaultV2(pegVaultV2, feeOverrides)).wait();
    console.log('setPegVaultV2', pegVaultV2);
  }
  const pegBridgeV2 = process.env.MESSAGE_BUS_PEG_BRIDGE_V2 as string;
  if (pegBridgeV2) {
    await (await messageBus.setPegBridgeV2(pegBridgeV2, feeOverrides)).wait();
    console.log('setPegBridgeV2', pegBridgeV2);
  }
}

async function setRFQBasics(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const rfqAddr = process.env.RFQ_ADDR as string;
  if (!rfqAddr) {
    return;
  }
  const rfq = RFQ__factory.connect(rfqAddr, deployerSigner);
  const pausers = (process.env.RFQ_PAUSERS as string).split(',');
  if (pausers[0].length > 0) {
    for (let i = 0; i < pausers.length; i++) {
      const pauser = pausers[i];
      await (await rfq.addPauser(pauser, feeOverrides)).wait();
      console.log('addPauser', pauser);
    }
  }
  const governors = (process.env.RFQ_GOVERNORS as string).split(',');
  if (governors[0].length > 0) {
    for (let i = 0; i < governors.length; i++) {
      const governor = governors[i];
      await (await rfq.addGovernor(governor, feeOverrides)).wait();
      console.log('addGovernor', governor);
    }
  }
  const remoteChains = (process.env.RFQ_REMOTE_CHAINS as string).split(',');
  const remoteRFQs = (process.env.RFQ_REMOTE_RFQS as string).split(',');
  if (remoteChains[0].length > 0 && remoteChains.length == remoteRFQs.length) {
    await (await rfq.setRemoteRfqContracts(remoteChains, remoteRFQs, feeOverrides)).wait();
    console.log('setRemoteRfqContracts', remoteChains, remoteRFQs);
  }
  const feeChains = (process.env.RFQ_FEE_CHAINS as string).split(',');
  const feePercs = (process.env.RFQ_FEE_PERCS as string).split(',');
  if (feeChains[0].length > 0 && feeChains.length == feePercs.length) {
    await (await rfq.setFeePerc(feeChains, feePercs, feeOverrides)).wait();
    console.log('setFeePerc', feeChains, feePercs);
  }
  const treasuryAddr = process.env.RFQ_TREASURE_ADDR as string;
  if (treasuryAddr) {
    await (await rfq.setTreasuryAddr(treasuryAddr, feeOverrides)).wait();
    console.log('setTreasuryAddr', treasuryAddr);
  }
  const weth = process.env.RFQ_NATIVE_WRAP as string;
  if (weth) {
    await (await rfq.setNativeWrap(weth, feeOverrides)).wait();
    console.log('setNativeWrap', weth);
  }
  const msgBus = process.env.RFQ_MSG_BUS as string;
  if (msgBus) {
    await (await rfq.setMessageBus(msgBus, feeOverrides)).wait();
    console.log('setMessageBus', msgBus);
  }
}

async function setBasics(): Promise<void> {
  await setBridgeBasics();
  await setOriginalTokenVaultBasics();
  await setPeggedTokenBridgeBasics();
  await setMessageBusBasics();
  await setRFQBasics();
}

setBasics();
