#!/usr/bin/env bun
// @ts-nocheck
import {
  createPublicClient,
  http,
  toHex,
  keccak256,
  pad,
  type Address,
  type Hex,
} from 'viem'

import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

/**
 * Reads V1 whitelist arrays (contracts[] and selectors[]) directly from storage
 * Uses the same slot calculation approach as the healthcheck script
 */
async function readV1WhitelistArrays(
  network: string,
  diamondAddress: Address,
  rpcUrl: string
): Promise<{ contracts: Address[]; selectors: Hex[] }> {
  const chain = getViemChainForNetworkName(network.toLowerCase())
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  })

  // Constants from healthcheck script
  const ALLOW_LIST_NAMESPACE =
    '0x7a8ac5d3b7183f220a0602439da45ea337311d699902d1ed11a3725a714e7f1e'
  const baseSlot = BigInt(ALLOW_LIST_NAMESPACE)
  const contractsLengthSlot = baseSlot + 2n
  const selectorsLengthSlot = baseSlot + 5n

  // Read array lengths
  const contractsLengthHex = await publicClient.getStorageAt({
    address: diamondAddress,
    slot: toHex(contractsLengthSlot),
  })
  const contractsLength = parseInt(contractsLengthHex ?? '0x0', 16)

  const selectorsLengthHex = await publicClient.getStorageAt({
    address: diamondAddress,
    slot: toHex(selectorsLengthSlot),
  })
  const selectorsLength = parseInt(selectorsLengthHex ?? '0x0', 16)

  // Compute array base slots for elements
  // In Solidity storage layout:
  // - Array length is stored at the slot (baseSlot + offset for this specific struct layout)
  // - Array elements are stored at keccak256(abi.encode(slot)) + i
  // The healthcheck reads length at baseSlot + 2 and baseSlot + 5, which suggests
  // the length slots are at those positions. For elements, we use keccak256(abi.encode(lengthSlot)) + i

  // For contracts[]: elements at keccak256(abi.encode(contractsLengthSlot)) + i
  const contractsBaseSlotHex = keccak256(
    pad(toHex(contractsLengthSlot), { size: 32 })
  )
  const contractsBaseSlot = BigInt(contractsBaseSlotHex)

  // For selectors[]: elements at keccak256(abi.encode(selectorsLengthSlot)) + i
  const selectorsBaseSlotHex = keccak256(
    pad(toHex(selectorsLengthSlot), { size: 32 })
  )
  const selectorsBaseSlot = BigInt(selectorsBaseSlotHex)

  // Read contracts array
  const contracts: Address[] = []
  for (let i = 0; i < contractsLength; i++) {
    const elementSlot = BigInt(contractsBaseSlot) + BigInt(i)
    const elementHex = await publicClient.getStorageAt({
      address: diamondAddress,
      slot: toHex(elementSlot),
    })
    if (
      elementHex &&
      elementHex !==
        '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      // Extract address from storage (last 20 bytes, padded)
      const address = ('0x' + elementHex.slice(-40)) as Address
      contracts.push(address)
    }
  }

  // Read selectors array
  const selectors: Hex[] = []
  for (let i = 0; i < selectorsLength; i++) {
    const elementSlot = BigInt(selectorsBaseSlot) + BigInt(i)
    const elementHex = await publicClient.getStorageAt({
      address: diamondAddress,
      slot: toHex(elementSlot),
    })
    if (
      elementHex &&
      elementHex !==
        '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      // Extract selector from storage (first 4 bytes, padded to 32 bytes)
      const selector = ('0x' + elementHex.slice(2, 10)) as Hex
      selectors.push(selector)
    }
  }

  return { contracts, selectors }
}

// Main execution
const network = process.argv[2]
const diamondAddress = process.argv[3] as Address
const rpcUrl = process.argv[4]

if (!network || !diamondAddress || !rpcUrl) {
  console.error(
    'Usage: readV1WhitelistArrays.ts <network> <diamondAddress> <rpcUrl>'
  )
  process.exit(1)
}

readV1WhitelistArrays(network, diamondAddress, rpcUrl)
  .then((result) => {
    // Output as JSON for bash to parse
    console.log(JSON.stringify(result))
  })
  .catch((error) => {
    console.error('Error reading V1 arrays:', error)
    process.exit(1)
  })
