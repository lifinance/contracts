/**
 * Contract Coverage Analysis Script
 *
 * This script analyzes test coverage from lcov.info file and categorizes contracts
 * by their line coverage percentage. It's designed to help track OKR progress
 * for contract test coverage goals.
 *
 * Features:
 * - Parses lcov.info file to extract coverage data for each contract
 * - Categorizes contracts into above/below threshold coverage
 * - Calculates percentage of included contracts above threshold
 * - Supports excluding specific contract folders from analysis
 * - Provides detailed line-by-line coverage statistics
 *
 * Usage:
 *   bun run script/utils/analyzeCoverage.ts [--exclude folder1,folder2] [--threshold 90]
 *
 * Examples:
 *   bun run script/utils/analyzeCoverage.ts
 *   bun run script/utils/analyzeCoverage.ts --threshold 95
 *   bun run script/utils/analyzeCoverage.ts --exclude "Libraries/LibBytes,Helpers/ExcessivelySafeCall"
 *   bun run script/utils/analyzeCoverage.ts --threshold 95 --exclude "Libraries/LibBytes"
 *
 * Package.json shortcut:
 *   bun okr:contract-coverage-above-90
 *
 * Prerequisites:
 * - Run "forge coverage" first to generate lcov.info file
 * - Ensure lcov.info exists in the project root
 *
 * Output:
 * - Lists contracts above/below threshold with coverage percentages
 * - Shows line counts (hit/total) for each contract
 * - Provides summary statistics including percentage above threshold
 * - Displays excluded folders when used
 *
 * OKR Tracking:
 * This script is used to track progress on contract test coverage objectives.
 * The default threshold of 90% aligns with typical coverage goals.
 */

import * as fs from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

/**
 * Coverage data for a single contract
 */
interface ICoverageData {
  contract: string
  linesHit: number
  totalLines: number
  coveragePercentage: number
}

/**
 * Analysis result containing categorized contracts and summary statistics
 */
interface IAnalysisResult {
  aboveThreshold: ICoverageData[]
  belowThreshold: ICoverageData[]
  totalIncluded: number
  percentageAbove: number
}

// Default configuration values
const DEFAULT_THRESHOLD = 90.0
const DEFAULT_EXCLUDED_FOLDERS: string[] = [
  // Add default folders to exclude here if needed
  // Example: "Libraries/LibBytes",
  // Example: "Helpers/ExcessivelySafeCall",
]

/**
 * Parse lcov.info file and extract coverage data for contracts
 * @param filePath Path to the lcov.info file
 * @param excludedFolders List of folder patterns to exclude from analysis
 * @returns Array of coverage data for each contract
 */
function parseLcovFile(
  filePath: string,
  excludedFolders: string[]
): ICoverageData[] {
  const coverageData: ICoverageData[] = []

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    // Split by end_of_record to get individual contract entries
    const records = content.split('end_of_record')

    for (const record of records) {
      const lines = record.trim().split('\n')
      if (!lines.length) continue

      // Find the source file line (SF: indicates source file path)
      let sourceFile: string | null = null
      for (const line of lines)
        if (line.startsWith('SF:')) {
          sourceFile = line.substring(3) // Remove 'SF:' prefix
          break
        }

      // Skip non-source files or files not in src/ directory
      if (!sourceFile || !sourceFile.startsWith('src/')) continue

      // Extract contract name from path (remove 'src/' prefix)
      const contractName = sourceFile.replace('src/', '')

      // Check if this contract should be excluded based on folder patterns
      const shouldExclude = excludedFolders.some((folder) =>
        contractName.startsWith(folder)
      )

      if (shouldExclude) continue

      // Find LF (lines found) and LH (lines hit) in the record
      // These are the key metrics for coverage calculation
      let linesFound = 0
      let linesHit = 0

      for (const line of lines)
        if (line.startsWith('LF:')) linesFound = parseInt(line.substring(3))
        else if (line.startsWith('LH:')) linesHit = parseInt(line.substring(3))

      if (linesFound > 0) {
        const coveragePercentage = (linesHit / linesFound) * 100
        coverageData.push({
          contract: contractName,
          linesHit,
          totalLines: linesFound,
          coveragePercentage,
        })
      }
    }
  } catch (error) {
    consola.error(
      'Error reading lcov file:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  }

  return coverageData
}

/**
 * Categorize contracts into above and below threshold coverage
 * @param coverageData Array of contract coverage data
 * @param threshold Coverage threshold percentage
 * @returns Analysis result with categorized contracts and summary statistics
 */
function categorizeContracts(
  coverageData: ICoverageData[],
  threshold: number
): IAnalysisResult {
  const aboveThreshold: ICoverageData[] = []
  const belowThreshold: ICoverageData[] = []

  // Categorize each contract based on coverage threshold
  for (const data of coverageData)
    if (data.coveragePercentage >= threshold) aboveThreshold.push(data)
    else belowThreshold.push(data)

  // Sort by coverage percentage (descending for above, ascending for below)
  aboveThreshold.sort((a, b) => b.coveragePercentage - a.coveragePercentage)
  belowThreshold.sort((a, b) => b.coveragePercentage - a.coveragePercentage)

  // Calculate summary statistics
  const totalIncluded = aboveThreshold.length + belowThreshold.length
  const percentageAbove =
    totalIncluded > 0 ? (aboveThreshold.length / totalIncluded) * 100 : 0

  return {
    aboveThreshold,
    belowThreshold,
    totalIncluded,
    percentageAbove,
  }
}

/**
 * Print formatted coverage analysis results
 * @param result Analysis result containing categorized contracts
 * @param threshold Coverage threshold percentage
 * @param excludedFolders List of excluded folders for transparency
 */
function printResults(
  result: IAnalysisResult,
  threshold: number,
  excludedFolders: string[]
): void {
  consola.log(
    `\n=== CONTRACT COVERAGE ANALYSIS (Threshold: ${threshold}%) ===\n`
  )

  // Show excluded folders for transparency
  if (excludedFolders.length > 0) {
    consola.log(`Excluded folders: ${excludedFolders.join(', ')}`)
    consola.log('')
  }

  // Display contracts above threshold
  consola.log(
    `Contracts with ${threshold}%+ coverage (${result.aboveThreshold.length} contracts):`
  )
  consola.log('-'.repeat(80))

  if (result.aboveThreshold.length > 0)
    for (const data of result.aboveThreshold)
      consola.log(
        `${data.contract.padEnd(50)} ${data.coveragePercentage
          .toFixed(1)
          .padStart(6)}% (${data.linesHit
          .toString()
          .padStart(3)}/${data.totalLines.toString().padStart(3)} lines)`
      )
  else consola.log('None')

  // Display contracts below threshold
  consola.log(
    `\nContracts below ${threshold}% coverage (${result.belowThreshold.length} contracts):`
  )
  consola.log('-'.repeat(80))

  if (result.belowThreshold.length > 0)
    for (const data of result.belowThreshold)
      consola.log(
        `${data.contract.padEnd(50)} ${data.coveragePercentage
          .toFixed(1)
          .padStart(6)}% (${data.linesHit
          .toString()
          .padStart(3)}/${data.totalLines.toString().padStart(3)} lines)`
      )
  else consola.log('None')

  // Display summary statistics
  consola.log(`\nSummary:`)
  consola.log(`Total contracts analyzed: ${result.totalIncluded}`)
  consola.log(
    `Contracts with ${threshold}%+ coverage: ${result.aboveThreshold.length}`
  )
  consola.log(
    `Contracts below ${threshold}% coverage: ${result.belowThreshold.length}`
  )
  consola.log(
    `Percentage of included contracts above ${threshold}%: ${result.percentageAbove.toFixed(
      1
    )}%`
  )
}

/**
 * Main coverage analysis function that orchestrates the entire process
 * @param threshold Coverage threshold percentage
 * @param excludedFolders List of folders to exclude from analysis
 */
async function analyzeContractCoverage(
  threshold: number,
  excludedFolders: string[]
): Promise<void> {
  const lcovFile = 'lcov.info'

  // Validate that lcov.info file exists
  if (!fs.existsSync(lcovFile)) {
    consola.error(`Error: Could not find ${lcovFile}`)
    consola.error(
      'Make sure you have run "forge coverage" first to generate the lcov.info file'
    )
    process.exit(1)
  }

  try {
    // Parse coverage data and generate analysis
    const coverageData = parseLcovFile(lcovFile, excludedFolders)
    const result = categorizeContracts(coverageData, threshold)
    printResults(result, threshold, excludedFolders)
  } catch (error) {
    consola.error(
      'Error analyzing coverage:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  }
}

const command = defineCommand({
  meta: {
    name: 'Contract Coverage Analysis',
    description:
      'Analyzes test coverage from lcov.info file and categorizes contracts by coverage percentage',
  },
  args: {
    threshold: {
      type: 'string',
      description: 'Coverage threshold percentage (default: 90)',
      default: DEFAULT_THRESHOLD.toString(),
    },
    exclude: {
      type: 'string',
      description: 'Comma-separated list of folders to exclude from analysis',
      default: '',
    },
  },

  async run({ args }) {
    const { threshold, exclude } = args
    const thresholdValue = parseFloat(threshold as string)
    const excludedFolders = [
      ...DEFAULT_EXCLUDED_FOLDERS,
      ...(exclude
        ? (exclude as string).split(',').map((f: string) => f.trim())
        : []),
    ]

    await analyzeContractCoverage(thresholdValue, excludedFolders)
  },
})

// Execute the main function with proper error handling
runMain(command)
