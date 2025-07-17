import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

interface INetworkScan {
  network: string
  chainId: number
  diamondAddress: string
  selectors: string[]
}

interface IScansFile {
  version: string
  generatedAt: string
  networks: {
    [key: string]: INetworkScan
  }
}

function flattenSelectors() {
  // Read the functionSelectorsResult.json file
  const functionSelectorsResultPath = path.join(
    __dirname,
    'functionSelectorsResult.json'
  )
  const functionSelectorsResultContent = readFileSync(
    functionSelectorsResultPath,
    'utf8'
  )
  const functionSelectorsResult: IScansFile = JSON.parse(
    functionSelectorsResultContent
  )

  // Create a Set to automatically handle deduplication
  const uniqueSelectors = new Set<string>()

  // Iterate through all networks and add their selectors to the Set
  Object.values(functionSelectorsResult.networks).forEach(
    (network: INetworkScan) => {
      network.selectors.forEach((selector) => {
        uniqueSelectors.add(selector)
      })
    }
  )

  // Convert Set to sorted array for consistent output
  const sortedSelectors = Array.from(uniqueSelectors).sort()

  // Create output object
  const output = {
    totalUniqueSelectors: sortedSelectors.length,
    selectors: sortedSelectors,
  }

  // Write to a new file
  const outputPath = path.join(__dirname, 'flattened-selectors.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))

  console.log(`Found ${sortedSelectors.length} unique selectors`)
  console.log(`Output written to ${outputPath}`)
}

// Run the function
flattenSelectors()
