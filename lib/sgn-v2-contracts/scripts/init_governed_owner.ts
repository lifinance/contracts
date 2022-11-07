import 'hardhat-deploy';

import * as dotenv from 'dotenv';

import { GovernedOwnerProxy__factory } from '../typechain/factories/GovernedOwnerProxy__factory';
import { getDeployerSigner, getFeeOverrides } from './common';

dotenv.config();

async function initGov(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const ownerProxyAddr = process.env.GOVERNED_OWNER_PROXY as string;
  if (!ownerProxyAddr) {
    return;
  }
  const simpleGovernanceAddr = process.env.SIMPLE_GOVERNANCE as string;
  if (!simpleGovernanceAddr) {
    return;
  }
  const governedOwnerProxy = GovernedOwnerProxy__factory.connect(ownerProxyAddr, deployerSigner);
  await (await governedOwnerProxy.initGov(simpleGovernanceAddr, feeOverrides)).wait();
  console.log('initGov', ownerProxyAddr, simpleGovernanceAddr);
}

initGov();
