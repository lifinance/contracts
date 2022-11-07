import 'hardhat-deploy';

import * as dotenv from 'dotenv';

import { Bridge__factory } from '../typechain/factories/Bridge__factory';
import { getDeployerSigner, getFeeOverrides } from './common';

dotenv.config();

async function resetSigners(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const bridgeAddr = process.env.BRIDGE as string;
  if (!bridgeAddr) {
    return;
  }
  const bridge = Bridge__factory.connect(bridgeAddr, deployerSigner);
  // Uncomment if needed
  // await (await bridge.notifyResetSigners(feeOverrides)).wait();

  const signers = (process.env.BRIDGE_SIGNERS as string).split(',');
  const powers = (process.env.BRIDGE_POWERS as string).split(',');
  await (await bridge.resetSigners(signers, powers, feeOverrides)).wait();
  console.log('resetSigners', signers, powers);
}

resetSigners();
