#!/usr/bin/env bun

/**
 * TypeScript Test Runner Script
 *
 * This script finds and runs all TypeScript test files in the script/ directory
 * while excluding external library tests from lib/ and node_modules/ directories.
 *
 * Features:
 * - Automatically discovers all .test.ts files in script/ directory
 * - Excludes lib/ and node_modules/ directories to avoid running external tests
 * - Uses Bun's built-in test runner with Jest-like syntax
 * - Provides clear output showing which test files were found and executed
 *
 * Usage:
 * - npm run test:ts (runs all TypeScript tests)
 * - bun script/runTypescriptTests.ts (direct execution)
 *
 * Output:
 * - Lists found test files
 * - Runs each test file with Bun's test runner
 * - Shows test results and summary
 */

import { execSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

function findTestFiles(dir: string): string[] {
  const testFiles: string[] = []

  try {
    const items = readdirSync(dir)

    for (const item of items) {
      const fullPath = join(dir, item)
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        // Skip lib/ and node_modules/ directories
        if (item === 'lib' || item === 'node_modules') continue

        testFiles.push(...findTestFiles(fullPath))
      } else if (item.endsWith('.test.ts')) testFiles.push(fullPath)
    }
  } catch (error) {
    // Ignore errors for directories we can't access
  }

  return testFiles
}

const scriptDir = join(process.cwd(), 'script')
const testFiles = findTestFiles(scriptDir)

if (testFiles.length === 0) {
  console.log('No TypeScript test files found in script/ directory')
  process.exit(0)
}

console.log(`Found ${testFiles.length} test file(s):`)
testFiles.forEach((file) => console.log(`  - ${file}`))
console.log()

// Run all test files together with a specific pattern
const testFilePatterns = testFiles.map((file) => `"${file}"`).join(' ')
console.log(`Running all tests with: bun test ${testFilePatterns}`)

try {
  execSync(`bun test ${testFilePatterns}`, { stdio: 'inherit' })
} catch (error) {
  console.error('Some tests failed')
  process.exit(1)
}

console.log('\n✅ All TypeScript tests completed successfully!')
