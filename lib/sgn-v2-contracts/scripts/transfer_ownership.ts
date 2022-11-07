import 'hardhat-deploy';

import * as dotenv from 'dotenv';

import { Ownable__factory } from '../typechain/factories/Ownable__factory';
import { getDeployerSigner, getFeeOverrides } from './common';

dotenv.config();

async function transferOwnership(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const contractAddr = process.env.TRANSFER_OWNERSHIP_CONTRACT as string;
  if (!contractAddr) {
    return;
  }
  const newOwner = process.env.TRANSFER_OWNERSHIP_NEW_OWNER as string;
  if (!newOwner) {
    return;
  }
  const contract = Ownable__factory.connect(contractAddr, deployerSigner);
  await (await contract.transferOwnership(newOwner, feeOverrides)).wait();
  console.log('transferOwnership', contractAddr, newOwner);
}

transferOwnership();
