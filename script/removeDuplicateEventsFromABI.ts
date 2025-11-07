/**
 * This script cleans duplicate events from ABI files and removes duplicate contract ABIs
 * before typechain type generation.
 *
 * Background:
 * Due to our pattern inheritance structure in Solidity contracts, some events
 * are inherited multiple times through different paths, resulting in duplicate event
 * definitions in the compiled ABI files. Additionally, some contracts exist in both
 * main and draft versions (e.g., ERC20Permit in both lib/openzeppelin-contracts and
 * lib/Permit2/lib/openzeppelin-contracts), causing typechain to generate duplicate
 * type definitions, leading to "Duplicate identifier" TypeScript errors.
 *
 * For example:
 * - OwnershipFacet.sol inherits from multiple interfaces that define the same events
 * - DiamondCutFacet.sol has similar inheritance patterns
 * - ERC20Permit and IERC20Permit exist in both main and draft versions
 *
 * Solution:
 * Instead of modifying our contract inheritance structure, we clean the ABI files
 * after compilation but before typechain type generation. This script:
 * 1. Removes duplicate contract ABI files (draft versions that duplicate main versions)
 * 2. Reads specified ABI files and removes duplicate events while preserving the first occurrence
 * 3. Saves the cleaned ABIs back to the files
 *
 * Usage:
 * This script is automatically run as part of the 'typechain' bun script:
 * 1. forge build src
 * 2. bun abi:clean
 * 3. typechain --target ethers-v5 ...
 *
 * Note:
 * - We remove draft versions of contracts that duplicate main versions
 * - We only clean specific files that we know have duplicate events
 * - The cleaning is based on event name and input parameters
 * - First occurrence of each event is preserved
 *
 * CI/CD Impact:
 * Without this cleaning step, the types.yaml GitHub Action (Types Bindings) would fail
 * due to duplicate type definitions in the generated TypeScript files. This script
 * ensures that the CI/CD pipeline can successfully generate and commit type bindings.
 */

import { existsSync, unlinkSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'

interface IEvent {
  type: string
  name: string
  inputs: any[]
  anonymous: boolean
}

async function removeDuplicateEventsFromABI() {
  // Remove duplicate contract ABI files that cause duplicate type exports
  // These are draft versions that duplicate the main versions
  const duplicateContractFiles = [
    'out/draft-ERC20Permit.sol/ERC20Permit.json',
    'out/draft-IERC20Permit.sol/IERC20Permit.json',
  ]

  for (const file of duplicateContractFiles) {
    if (existsSync(file)) {
      try {
        unlinkSync(file)
        console.log(`Removed duplicate contract ABI: ${file}`)
      } catch (error) {
        console.error(
          `Error removing ${file}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  // Files that we know have duplicate events
  const filesToClean = [
    'out/OwnershipFacet.sol/OwnershipFacet.json',
    'out/DiamondCutFacet.sol/DiamondCutFacet.json',
  ]

  for (const file of filesToClean) {
    if (!existsSync(file)) {
      console.log(`File ${file} not found, skipping...`)
      continue
    }

    let content
    let abi
    try {
      const fileContent = await readFile(file, 'utf8')
      content = JSON.parse(fileContent)
      if (!content.abi || !Array.isArray(content.abi)) {
        console.error(`Invalid ABI format in ${file}, skipping...`)
        continue
      }
      abi = content.abi as any[]
    } catch (error) {
      console.error(
        `Error reading ${file}:`,
        error instanceof Error ? error.message : String(error)
      )
      continue
    }

    // Track seen events to remove duplicates
    const seenEvents = new Map<string, IEvent>()
    const cleanedABI = abi.filter((item) => {
      if (item.type === 'event') {
        const key = `${item.name}_${JSON.stringify(item.inputs)}`
        if (seenEvents.has(key)) return false

        seenEvents.set(key, item)
      }
      return true
    })

    // Update the ABI in the file
    content.abi = cleanedABI
    try {
      await writeFile(file, JSON.stringify(content, null, 2), 'utf8')
      console.log(`Cleaned duplicate events from ${file}`)
    } catch (error) {
      console.error(
        `Error writing to ${file}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}

removeDuplicateEventsFromABI().catch(console.error)
