import 'hardhat-deploy';

import * as dotenv from 'dotenv';

import { MintSwapCanonicalToken__factory } from '../typechain/factories/MintSwapCanonicalToken__factory';
import { getDeployerSigner, getFeeOverrides } from './common';

dotenv.config();

async function updateBridgeSupplyCap(): Promise<void> {
  const deployerSigner = await getDeployerSigner();
  const feeOverrides = await getFeeOverrides();

  const tokenAddr = process.env.MINT_SWAP_CANONICAL_TOKEN as string;
  if (!tokenAddr) {
    return;
  }
  const bridgeAddr = process.env.MINT_SWAP_CANONICAL_TOKEN_BRIDGE as string;
  if (!bridgeAddr) {
    return;
  }
  const mintSwapCanonicalToken = MintSwapCanonicalToken__factory.connect(tokenAddr, deployerSigner);
  const cap = process.env.MINT_SWAP_CANONICAL_TOKEN_CAP as string;
  await (await mintSwapCanonicalToken.updateBridgeSupplyCap(bridgeAddr, cap, feeOverrides)).wait();
  console.log('updateBridgeSupplyCap', tokenAddr, bridgeAddr, cap);
}

updateBridgeSupplyCap();
