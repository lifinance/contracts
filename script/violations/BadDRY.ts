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

// Violation: Re-implements network config reading that exists in viemScriptHelpers
function getNetworkConfig(networkName: string) {
  // Violation: Should use getViemChainForNetworkName from viemScriptHelpers
  const networks = require('../../config/networks.json')
  return networks[networkName]
}

// Violation: Re-implements deployment address reading that exists in deploymentHelpers
function getDeploymentAddress(network: string, contractName: string) {
  // Violation: Should use getDeployments from deploymentHelpers
  const deployments = require(`../../deployments/${network}.json`)
  return deployments[contractName]
}

// Violation: Re-implements address validation that exists in helpers
function validateAddress(address: string): Address {
  // Violation: Should use getAddress from viem (already imported but re-implemented)
  if (!address.startsWith('0x') || address.length !== 42) {
    throw new Error('Invalid address')
  }
  return address as Address
}

// Violation: Re-implements client creation pattern that exists in demoScriptHelpers
function createClient(networkName: string) {
  // Violation: Should use helpers from demoScriptHelpers or viemScriptHelpers
  const network = getNetworkConfig(networkName)
  return createPublicClient({
    transport: http(network.rpcUrl),
  })
}

export async function badFunction() {
  // Uses duplicated logic instead of helpers
  const network = getNetworkConfig('mainnet')
  const address = getDeploymentAddress('mainnet', 'LiFiDiamond')
  const client = createClient('mainnet')
}
