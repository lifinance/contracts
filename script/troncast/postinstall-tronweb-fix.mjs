#!/usr/bin/env node

import fs from 'fs'
import { execSync } from 'child_process'

console.log('Applying TronWeb proto fix...')

// Find all affected files
let files = []
try {
  const findCommand = `find node_modules/tronweb -name "*.cjs" -path "*/protocol/*" 2>/dev/null | xargs grep -l "goog.object.extend(proto" 2>/dev/null || true`
  files = execSync(findCommand, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean)
} catch (e) {
  console.log('TronWeb not installed, skipping patch')
  process.exit(0)
}

if (files.length === 0) {
  console.log('No files to patch')
  process.exit(0)
}

console.log(`Found ${files.length} files to patch`)

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
    console.error(`Error processing ${file}:`, e.message)
  }
})

console.log(`✓ Patched ${patchedCount} files`)
console.log(`✓ ${alreadyPatchedCount} files were already patched`)
console.log('TronWeb proto fix applied successfully!')
