/**
 * Violation: Uses deprecated ethers.js helpers instead of viem.
 * 
 * Convention violation: Contract interactions MUST use viem.
 * DO NOT use deprecated ethers.js helpers like:
 * - getProvider
 * - getWalletFromPrivateKeyInDotEnv
 * - ethers sendTransaction
 * - ensureBalanceAndAllowanceToDiamond
 * 
 * Use TypeChain types from typechain/ directory (e.g., ILiFi.BridgeDataStruct)
 * 
 * This file violates by using ethers.js for contract interactions.
 */

import { ethers } from 'ethers'
import { consola } from 'consola'

// Violation: Uses deprecated ethers.js getProvider helper
// Should use viem's createPublicClient instead
function getProvider(network: string) {
  return ethers.getDefaultProvider(network)
}

// Violation: Uses deprecated ethers.js getWalletFromPrivateKeyInDotEnv pattern
// Should use viem's privateKeyToAccount instead
function getWalletFromPrivateKeyInDotEnv() {
  const privateKey = process.env.PRIVATE_KEY || ''
  return new ethers.Wallet(privateKey, getProvider('mainnet'))
}

// Violation: Uses ethers.js sendTransaction instead of viem
async function sendTransaction() {
  const wallet = getWalletFromPrivateKeyInDotEnv()
  const contract = new ethers.Contract('0x1234567890123456789012345678901234567890', ['function transfer()'], wallet)
  
  // Violation: Should use viem's writeContract or sendTransaction
  const tx = await contract.transfer()
  await tx.wait()
}

// Violation: Uses deprecated ensureBalanceAndAllowanceToDiamond pattern
// Should use viem-based helpers from deploymentHelpers or demoScriptHelpers
async function ensureBalanceAndAllowanceToDiamond(token: string, amount: string) {
  const wallet = getWalletFromPrivateKeyInDotEnv()
  const tokenContract = new ethers.Contract(token, ['function approve(address,uint256)'], wallet)
  await tokenContract.approve('0x...', amount)
}

export { getProvider, getWalletFromPrivateKeyInDotEnv, sendTransaction, ensureBalanceAndAllowanceToDiamond }
