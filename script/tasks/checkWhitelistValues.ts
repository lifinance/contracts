#!/usr/bin/env bun

/**
 * Purpose:
 *   - Extract and calculate expected whitelist values (addresses, selectors, pairs) from whitelist.json
 *   - Used to derive EXPECTED_* constants for fork test files
 *
 * Usage:
 *   bun script/tasks/checkWhitelistValues.ts --network mainnet
 *   bun script/tasks/checkWhitelistValues.ts --network arbitrum
 *   bun script/tasks/checkWhitelistValues.ts --network base
 */

import fs from 'fs'

import { defineCommand, runMain } from 'citty'

interface IContract {
  address?: string
  functions?: Record<string, string>
  selectors?: Array<string | { selector: string }>
}

interface IDexConfig {
  name: string
  contracts?: Record<string, IContract[]>
}

interface IPeripheryConfig {
  [network: string]: IContract[]
}

interface IWhitelistConfig {
  DEXS?: IDexConfig[]
  PERIPHERY?: IPeripheryConfig
}

interface IPair {
  address: string
  selectors: string[]
}

const command = defineCommand({
  meta: {
    name: 'checkWhitelistValues',
    description: 'Check whitelist values for a given network',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name (e.g., mainnet, arbitrum, base)',
      required: true,
    },
  },
  run({ args }) {
    const network = args.network

    if (!network) {
      console.error('Error: --network argument is required')
      console.error(
        'Usage: bun script/tasks/checkWhitelistValues.ts --network <networkName>'
      )
      console.error(
        'Example: bun script/tasks/checkWhitelistValues.ts --network mainnet'
      )
      process.exit(1)
    }

    const wl: IWhitelistConfig = JSON.parse(
      fs.readFileSync('config/whitelist.json', 'utf8')
    )

    const addresses = new Set<string>()
    const selectors = new Set<string>()
    // Use a Map to handle duplicate addresses (same address in both DEXS and PERIPHERY)
    const addressToSelectors = new Map<string, string[]>()

    // Helper function to extract selectors from a contract
    function extractSelectors(contract: IContract): string[] {
      if (
        contract.selectors &&
        Array.isArray(contract.selectors) &&
        contract.selectors.length > 0
      ) {
        // PERIPHERY contracts use 'selectors' array
        return contract.selectors.map((s) =>
          typeof s === 'string' ? s : s.selector || String(s)
        )
      } else if (
        contract.functions &&
        Object.keys(contract.functions).length > 0
      ) {
        // DEXS contracts use 'functions' object
        return Object.keys(contract.functions)
      } else {
        // approveTo-only contract (no functions/selectors, only 0xffffffff)
        return ['0xffffffff']
      }
    }

    // Extract from DEXS section for the specified network
    for (const dex of wl.DEXS || []) {
      for (const contract of dex.contracts?.[network] || []) {
        if (contract && contract.address) {
          const address = contract.address.toLowerCase()
          addresses.add(address)

          const contractSelectors = extractSelectors(contract)

          // If address already exists (from PERIPHERY), merge selectors
          const existingSelectors = addressToSelectors.get(address)
          if (existingSelectors) {
            const mergedSelectors = [
              ...new Set([...existingSelectors, ...contractSelectors]),
            ]
            addressToSelectors.set(address, mergedSelectors)
          } else {
            addressToSelectors.set(address, contractSelectors)
          }

          contractSelectors.forEach((sel) => selectors.add(sel.toLowerCase()))
        }
      }
    }

    // Extract from PERIPHERY section for the specified network
    // Note: PERIPHERY contracts use 'selectors' array instead of 'functions' object
    const networkPeriphery = wl.PERIPHERY?.[network] || []
    for (const contract of networkPeriphery) {
      if (contract && contract.address) {
        const address = contract.address.toLowerCase()
        addresses.add(address)

        const contractSelectors = extractSelectors(contract)

        // If address already exists (from DEXS), merge selectors
        const existingSelectors = addressToSelectors.get(address)
        if (existingSelectors) {
          const mergedSelectors = [
            ...new Set([...existingSelectors, ...contractSelectors]),
          ]
          addressToSelectors.set(address, mergedSelectors)
        } else {
          addressToSelectors.set(address, contractSelectors)
        }

        contractSelectors.forEach((sel) => selectors.add(sel.toLowerCase()))
      }
    }

    // Convert Map to pairs array for consistency with original logic
    const pairs: IPair[] = Array.from(addressToSelectors.entries()).map(
      ([address, selectors]) => ({
        address,
        selectors,
      })
    )

    const totalPairs = pairs.reduce(
      (sum, pair) => sum + pair.selectors.length,
      0
    )

    console.log(`=== Expected values for ${network} (DEXS + PERIPHERY) ===`)
    console.log('Unique addresses count:', addresses.size)
    console.log('Unique selectors count:', selectors.size)
    console.log('Total contract-selector pairs:', totalPairs)

    // Count breakdown
    const dexsCount = new Set<string>()
    for (const dex of wl.DEXS || []) {
      for (const contract of dex.contracts?.[network] || []) {
        if (contract && contract.address) {
          dexsCount.add(contract.address.toLowerCase())
        }
      }
    }

    const peripheryCount = new Set<string>()
    for (const contract of networkPeriphery) {
      if (contract && contract.address) {
        peripheryCount.add(contract.address.toLowerCase())
      }
    }

    console.log('\n=== Breakdown ===')
    console.log('Addresses from DEXS:', dexsCount.size)
    console.log('Addresses from PERIPHERY:', peripheryCount.size)

    // Debug: Check for duplicate addresses between DEXS and PERIPHERY
    const duplicateAddresses: string[] = []
    for (const address of dexsCount) {
      if (peripheryCount.has(address)) {
        duplicateAddresses.push(address)
      }
    }

    if (duplicateAddresses.length > 0) {
      console.log(
        '\n=== WARNING: Duplicate addresses found in both DEXS and PERIPHERY ==='
      )
      duplicateAddresses.forEach((addr) => console.log('  -', addr))
    }

    // Debug: Print detailed pair counts per contract
    console.log('\n=== Detailed Pair Counts ===')
    console.log('Total contracts:', pairs.length)
    let detailedTotal = 0
    pairs.forEach((pair, idx) => {
      detailedTotal += pair.selectors.length
      if (idx < 5 || idx >= pairs.length - 2) {
        // Show first 5 and last 2 for debugging
        console.log(
          `  Contract ${idx + 1}: ${pair.address} - ${
            pair.selectors.length
          } selectors`
        )
      }
    })
    console.log('Detailed total (sum of all selectors):', detailedTotal)
    console.log('Calculated total (from reduce):', totalPairs)
  },
})

runMain(command)
