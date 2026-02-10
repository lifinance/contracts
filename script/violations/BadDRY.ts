/**
 * Violation: Duplicates code that should use existing helpers.
 * 
 * Convention violation: Check existing helpers in:
 * - script/common/
 * - script/utils/
 * - script/demoScripts/utils/
 * 
 * Key helpers: deploymentHelpers.ts, demoScriptHelpers.ts, script/common/types.ts
 * 
 * This file violates by re-implementing logic that exists in helpers.
 */

import { consola } from 'consola'
import { createPublicClient, http, getAddress, type Address } from 'viem'
// Violation: Should import getDeployments from '../utils/deploymentHelpers'
// Violation: Should import getViemChainForNetworkName from '../utils/viemScriptHelpers'

// Violation: Re-implements network config reading that exists in viemScriptHelpers.getViemChainForNetworkName
function getNetworkConfig(networkName: string) {
  // Violation: Should use getViemChainForNetworkName from viemScriptHelpers instead
  const networks = require('../../config/networks.json')
  return networks[networkName]
}

// Violation: Re-implements deployment address reading that exists in deploymentHelpers.getDeployments
function getDeploymentAddress(network: string, contractName: string) {
  // Violation: Should use getDeployments from deploymentHelpers instead
  const deployments = require(`../../deployments/${network}.json`)
  return deployments[contractName]
}

// Violation: Re-implements address validation that getAddress from viem already provides
function validateAddress(address: string): Address {
  // Violation: Should use getAddress from viem (already imported but re-implemented)
  if (!address.startsWith('0x') || address.length !== 42) {
    throw new Error('Invalid address')
  }
  return address as Address
}

// Violation: Re-implements client creation pattern that exists in demoScriptHelpers
function createClient(networkName: string) {
  // Violation: Should use helpers from demoScriptHelpers or viemScriptHelpers instead
  const network = getNetworkConfig(networkName)
  return createPublicClient({
    transport: http(network.rpcUrl),
  })
}

export async function badFunction() {
  // Violation: Uses duplicated logic instead of helpers
  // Should use: getDeployments('mainnet') from deploymentHelpers
  // Should use: getViemChainForNetworkName('mainnet') from viemScriptHelpers
  const network = getNetworkConfig('mainnet')
  const address = getDeploymentAddress('mainnet', 'LiFiDiamond')
  const client = createClient('mainnet')
  const validated = validateAddress(address) // Should use getAddress(address) directly
  
  consola.info(`Using duplicated logic instead of helpers: ${validated}`)
}
