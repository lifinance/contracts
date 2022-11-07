import 'hardhat-deploy';

import * as dotenv from 'dotenv';
import { BigNumber } from 'ethers';

import { parseUnits } from '@ethersproject/units';

import { Bridge__factory } from '../typechain/factories/Bridge__factory';
import { OriginalTokenVault__factory } from '../typechain/factories/OriginalTokenVault__factory';
import { PeggedTokenBridge__factory } from '../typechain/factories/PeggedTokenBridge__factory';
import { getDeployerSigner, getFeeOverrides } from './common';

import type { ContractTransaction, Overrides } from '@ethersproject/contracts';
import type { BigNumberish } from '@ethersproject/bignumber';

dotenv.config();

function getParseUnitsCallback(
  unitNames: BigNumberish[]
): (value: string, index: number, array: string[]) => BigNumber {
  return (s, i) => parseUnits(s, unitNames[i]);
}

async function setLimitIfSpecified(
  limitEnv: string,
  tokens: string[],
  decimals: string[],
  methodName: string,
  method: (
    _tokens: string[],
    _amounts: BigNumberish[],
    overrides?: Overrides & { from?: string | Promise<string> }
  ) => Promise<ContractTransaction>,
  feeOverrides: Overrides
): Promise<void> {
  if (limitEnv) {
    const limitStr = limitEnv.split(',');
    if (limitEnv.length > 0 && limitStr.length === decimals.length) {
      const limits = limitStr.map(getParseUnitsCallback(decimals));
      await (await method(tokens, limits, feeOverrides)).wait();
      console.log(
        methodName,
        tokens,
        limits.map((limit) => limit.toString())
      );
    }
  }
}

async function setBridgeLimits(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const bridgeAddr = process.env.BRIDGE as string;
  if (!bridgeAddr) {
    return;
  }
  const bridge = Bridge__factory.connect(bridgeAddr, deployerSigner);
  const tokens = (process.env.BRIDGE_LIMIT_TOKENS as string).split(',');
  const decimals = (process.env.BRIDGE_LIMIT_DECIMALS as string).split(',');

  await setLimitIfSpecified(
    process.env.BRIDGE_LIMIT_MIN_ADDS as string,
    tokens,
    decimals,
    'setMinAdd',
    bridge.setMinAdd,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.BRIDGE_LIMIT_MIN_SENDS as string,
    tokens,
    decimals,
    'setMinSend',
    bridge.setMinSend,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.BRIDGE_LIMIT_MAX_SENDS as string,
    tokens,
    decimals,
    'setMaxSend',
    bridge.setMaxSend,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.BRIDGE_LIMIT_EPOCH_VOLUME_CAPS as string,
    tokens,
    decimals,
    'setEpochVolumeCaps',
    bridge.setEpochVolumeCaps,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.BRIDGE_LIMIT_DELAY_THRESHOLDS as string,
    tokens,
    decimals,
    'setDelayThresholds',
    bridge.setDelayThresholds,
    feeOverrides
  );
}

async function setOriginalTokenVaultLimits(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const originalTokenVaultAddr = process.env.ORIGINAL_TOKEN_VAULT as string;
  if (!originalTokenVaultAddr) {
    return;
  }
  const originalTokenVault = OriginalTokenVault__factory.connect(originalTokenVaultAddr, deployerSigner);
  const tokens = (process.env.ORIGINAL_TOKEN_VAULT_LIMIT_TOKENS as string).split(',');
  const decimals = (process.env.ORIGINAL_TOKEN_VAULT_LIMIT_DECIMALS as string).split(',');

  await setLimitIfSpecified(
    process.env.ORIGINAL_TOKEN_VAULT_LIMIT_MIN_DEPOSITS as string,
    tokens,
    decimals,
    'setMinDeposit',
    originalTokenVault.setMinDeposit,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.ORIGINAL_TOKEN_VAULT_LIMIT_MAX_DEPOSITS as string,
    tokens,
    decimals,
    'setMaxDeposit',
    originalTokenVault.setMaxDeposit,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.ORIGINAL_TOKEN_VAULT_LIMIT_EPOCH_VOLUME_CAPS as string,
    tokens,
    decimals,
    'setEpochVolumeCaps',
    originalTokenVault.setEpochVolumeCaps,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.ORIGINAL_TOKEN_VAULT_LIMIT_DELAY_THRESHOLDS as string,
    tokens,
    decimals,
    'setDelayThresholds',
    originalTokenVault.setDelayThresholds,
    feeOverrides
  );
}

async function setPeggedTokenBridgeLimits(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const peggedTokenBridgeAddr = process.env.PEGGED_TOKEN_BRIDGE as string;
  if (!peggedTokenBridgeAddr) {
    return;
  }
  const peggedTokenBridge = PeggedTokenBridge__factory.connect(peggedTokenBridgeAddr, deployerSigner);
  const tokens = (process.env.PEGGED_TOKEN_BRIDGE_LIMIT_TOKENS as string).split(',');
  const decimals = (process.env.PEGGED_TOKEN_BRIDGE_LIMIT_DECIMALS as string).split(',');

  await setLimitIfSpecified(
    process.env.PEGGED_TOKEN_BRIDGE_LIMIT_MIN_BURNS as string,
    tokens,
    decimals,
    'setMinBurn',
    peggedTokenBridge.setMinBurn,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.PEGGED_TOKEN_BRIDGE_LIMIT_MAX_BURNS as string,
    tokens,
    decimals,
    'setMaxBurn',
    peggedTokenBridge.setMaxBurn,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.PEGGED_TOKEN_BRIDGE_LIMIT_EPOCH_VOLUME_CAPS as string,
    tokens,
    decimals,
    'setEpochVolumeCaps',
    peggedTokenBridge.setEpochVolumeCaps,
    feeOverrides
  );
  await setLimitIfSpecified(
    process.env.PEGGED_TOKEN_BRIDGE_LIMIT_DELAY_THRESHOLDS as string,
    tokens,
    decimals,
    'setDelayThresholds',
    peggedTokenBridge.setDelayThresholds,
    feeOverrides
  );
}

async function setLimits(): Promise<void> {
  await setBridgeLimits();
  await setOriginalTokenVaultLimits();
  await setPeggedTokenBridgeLimits();
}

setLimits();
