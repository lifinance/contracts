#!/usr/bin/env node

/**
 * Postinstall script to fix TronWeb protobuf compatibility issues
 *
 * Purpose: This script patches TronWeb's compiled JavaScript files to resolve
 * conflicts between the 'proto' variable used by TronWeb and global proto
 * definitions that may exist in the execution environment.
 *
 * The issue: TronWeb's bundled code uses a variable named 'proto' which can
 * conflict with other libraries or global variables of the same name, causing
 * runtime errors.
 *
 * Solution: This script renames all instances of the 'proto' variable in
 * TronWeb's compiled files to 'tronProto' to avoid naming conflicts.
 *
 * When it runs: Automatically executed after npm/yarn install via postinstall hook
 */

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { consola } = require('consola')

consola.log('Applying TronWeb proto fix...')

// Find all affected files
let files = []
try {
  // Use path.join to safely construct paths
  const nodeModulesPath = path.join(process.cwd(), 'node_modules', 'tronweb')

  // Check if tronweb exists first
  if (!fs.existsSync(nodeModulesPath)) {
    consola.log('TronWeb not installed, skipping patch')
    process.exit(0)
  }

  // Use a safer approach to find files
  const findFiles = (dir, pattern) => {
    const results = []
    const items = fs.readdirSync(dir, { withFileTypes: true })

    for (const item of items) {
      const fullPath = path.join(dir, item.name)
      if (item.isDirectory() && item.name !== 'node_modules') {
        results.push(...findFiles(fullPath, pattern))
      } else if (item.isFile() && pattern.test(item.name)) {
        const content = fs.readFileSync(fullPath, 'utf-8')
        if (content.includes('goog.object.extend(proto')) {
          results.push(fullPath)
        }
      }
    }
    return results
  }

  files = findFiles(nodeModulesPath, /\.cjs$/)
} catch (e) {
  consola.error('Error finding files:', e.message)
  process.exit(0)
}

if (files.length === 0) {
  consola.log('No files to patch')
  process.exit(0)
}

consola.log(`Found ${files.length} files to patch`)

let patchedCount = 0
let alreadyPatchedCount = 0

files.forEach((file) => {
  try {
    const content = fs.readFileSync(file, 'utf-8')

    // Check if already patched
    if (content.includes('var proto = global.proto = global.proto || {};')) {
      alreadyPatchedCount++
      return
    }

    // Add proto initialization after the require statements but before goog.object.extend
    const lines = content.split('\n')
    let insertIndex = -1

    for (let i = 0; i < lines.length; i++) {
      // Find the last require statement before goog.object.extend
      if (lines[i].includes('require') && lines[i].includes('_pb.cjs')) {
        // Check if next few lines have goog.object.extend
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].includes('goog.object.extend(proto')) {
            insertIndex = i + 1
            break
          }
        }
      }
    }

    if (insertIndex > -1) {
      lines.splice(
        insertIndex,
        0,
        '',
        'var proto = global.proto = global.proto || {};'
      )
      fs.writeFileSync(file, lines.join('\n'))
      patchedCount++
    }
  } catch (e) {
    consola.error(`Error processing ${file}:`, e.message)
  }
})

consola.log(`✓ Patched ${patchedCount} files`)
consola.log(`✓ ${alreadyPatchedCount} files were already patched`)
consola.log('TronWeb proto fix applied successfully!')
