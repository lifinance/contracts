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
 * This file violates by using ethers.js for contract interactions.
 */

import { ethers } from 'ethers'
import { consola } from 'consola'

// Violation: Uses deprecated ethers.js getProvider helper
function getProvider(network: string) {
  // Violation: Should use viem's createPublicClient instead
  return ethers.getDefaultProvider(network)
}

// Violation: Uses deprecated ethers.js getWalletFromPrivateKeyInDotEnv
function getWallet() {
  // Violation: Should use viem's privateKeyToAccount instead
  const privateKey = process.env.PRIVATE_KEY || ''
  return new ethers.Wallet(privateKey, getProvider('mainnet'))
}

// Violation: Uses ethers.js sendTransaction instead of viem
async function sendTransaction() {
  const wallet = getWallet()
  const contract = new ethers.Contract('0x...', ['function transfer()'], wallet)
  
  // Violation: Should use viem's writeContract or sendTransaction
  await contract.transfer()
}

// Violation: Uses deprecated ensureBalanceAndAllowanceToDiamond helper
async function ensureBalance() {
  // Violation: Should use viem-based helpers from deploymentHelpers or demoScriptHelpers
  // This function doesn't exist in ethers.js, but represents deprecated pattern
}
