#!/usr/bin/env node

/**
 * Postinstall script to fix TronWeb protobuf compatibility issues
 *
 * Purpose: This script patches TronWeb's compiled JavaScript files so that
 * the 'proto' variable they rely on is always defined when they load.
 *
 * The issue: TronWeb's bundled protobuf files reference a shared 'proto'
 * variable without declaring it, relying on another module having already
 * created `global.proto`. Depending on module load order that global may not
 * exist yet, causing runtime errors.
 *
 * Solution: This script inserts `var proto = global.proto = global.proto || {};`
 * before the first `goog.object.extend(proto, ...)` usage in each affected
 * file, so `proto` is defined regardless of module load order.
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
const skippedFiles = []

files.forEach((file) => {
  try {
    const content = fs.readFileSync(file, 'utf-8')

    // Check if already patched
    if (content.includes('var proto = global.proto = global.proto || {};')) {
      alreadyPatchedCount++
      return
    }

    const lines = content.split('\n')
    const insertIndex = lines.findIndex((line) =>
      line.includes('goog.object.extend(proto')
    )

    if (insertIndex > -1) {
      lines.splice(
        insertIndex,
        0,
        '',
        'var proto = global.proto = global.proto || {};'
      )
      // Write to a temp file and rename so a failed write cannot truncate the original
      const tmpFile = `${file}.tmp`
      try {
        fs.writeFileSync(tmpFile, lines.join('\n'))
        fs.renameSync(tmpFile, file)
      } catch (writeError) {
        fs.rmSync(tmpFile, { force: true })
        throw writeError
      }
      patchedCount++
    } else {
      skippedFiles.push(file)
    }
  } catch (e) {
    consola.error(`Error processing ${file}:`, e.message)
    skippedFiles.push(file)
  }
})

consola.log(`✓ Patched ${patchedCount} files`)
consola.log(`✓ ${alreadyPatchedCount} files were already patched`)
if (skippedFiles.length > 0) {
  consola.warn(`✗ Skipped ${skippedFiles.length} files (not patched):`)
  skippedFiles.forEach((file) => consola.warn(`  - ${file}`))
} else {
  consola.log('TronWeb proto fix applied successfully!')
}
