/**
 * This script cleans duplicate events from ABI files before typechain type generation.
 *
 * Background:
 * Due to our pattern inheritance structure in Solidity contracts, some events
 * are inherited multiple times through different paths, resulting in duplicate event
 * definitions in the compiled ABI files. This causes typechain to generate duplicate
 * type definitions, leading to "Duplicate identifier" TypeScript errors.
 *
 * For example:
 * - OwnershipFacet.sol inherits from multiple interfaces that define the same events
 * - DiamondCutFacet.sol has similar inheritance patterns
 *
 * Solution:
 * Instead of modifying our contract inheritance structure, we clean the ABI files
 * after compilation but before typechain type generation. This script:
 * 1. Reads specified ABI files
 * 2. Removes duplicate events while preserving the first occurrence
 * 3. Saves the cleaned ABIs back to the files
 *
 * Usage:
 * This script is automatically run as part of the 'typechain' bun script:
 * 1. forge build src
 * 2. bun abi:clean
 * 3. typechain --target ethers-v5 ...
 *
 * Note:
 * - We only clean specific files that we know have duplicate events
 * - The cleaning is based on event name and input parameters
 * - First occurrence of each event is preserved
 *
 * CI/CD Impact:
 * Without this cleaning step, the types.yaml GitHub Action (Types Bindings) would fail
 * due to duplicate type definitions in the generated TypeScript files. This script
 * ensures that the CI/CD pipeline can successfully generate and commit type bindings.
 */

import fs from 'fs-extra'

interface Event {
  type: string
  name: string
  inputs: any[]
  anonymous: boolean
}

async function removeDuplicateEventsFromABI() {
  // Files that we know have duplicate events
  const filesToClean = [
    'out/OwnershipFacet.sol/OwnershipFacet.json',
    'out/DiamondCutFacet.sol/DiamondCutFacet.json',
  ]

  for (const file of filesToClean) {
    if (!fs.existsSync(file)) {
      console.log(`File ${file} not found, skipping...`)
      continue
    }

    let content
    let abi
    try {
      content = await fs.readJson(file)
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
    const seenEvents = new Map<string, Event>()
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
      await fs.writeJson(file, content, { spaces: 2 })
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
