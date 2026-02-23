#!/usr/bin/env bun

/**
 * Contract Changelog Generator
 * 
 * Analyzes Solidity contract changes and generates changelog entries
 * for breaking changes, additions, modifications, and removals.
 * 
 * Supports three modes:
 * - Basic: Regex-based analysis (fast, simple)
 * - Advanced: AST + Forge + Heuristic analysis (default, accurate, free)
 * - AI: Uses OpenAI/Anthropic for semantic analysis (set USE_AI=true)
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  analyzeContractChangesWithAI,
  buildContractDiff,
  getFileDiff,
} from './aiChangelogAnalyzer'
import {
  analyzeContractAdvanced,
  enhanceWithCommitContext,
  type AdvancedChangelogEntry,
} from './advancedChangelogGenerator'

const CHANGELOG_DIR = 'changelog'
const CONTRACTS_DIR = 'src'
const USE_AI = process.env.USE_AI === 'true'
const USE_ADVANCED = process.env.USE_ADVANCED !== 'false' // Default true
const AI_PROVIDER = (process.env.AI_PROVIDER || 'coderabbit') as 'coderabbit' | 'openai' | 'anthropic'

interface ChangelogEntry {
  date: string
  commitSha: string
  commitMessage: string
  changes: {
    breaking: string[]
    added: string[]
    changed: string[]
    removed: string[]
    fixed: string[]
  }
}

interface ContractAnalysis {
  file: string
  contractName: string
  functions: {
    added: string[]
    removed: string[]
    modified: string[]
  }
  events: {
    added: string[]
    removed: string[]
  }
  modifiers: {
    added: string[]
    removed: string[]
  }
  errors: {
    added: string[]
    removed: string[]
  }
  storageVars: {
    added: string[]
    removed: string[]
    modified: string[]
  }
}

/**
 * Get changed Solidity files from the last commit
 */
function getChangedSolidityFiles(): string[] {
  try {
    const output = execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf-8' })
    return output
      .split('\n')
      .filter(file => file.startsWith(CONTRACTS_DIR) && file.endsWith('.sol'))
  } catch (error) {
    console.error('Error getting changed files:', error)
    return []
  }
}

/**
 * Get file content from a specific commit
 */
function getFileAtCommit(file: string, commit: string): string | null {
  try {
    return execSync(`git show ${commit}:${file}`, { encoding: 'utf-8' })
  } catch {
    return null
  }
}

/**
 * Extract contract name from file content
 */
function extractContractName(content: string, filename: string): string {
  // Try to find main contract definition
  const contractMatch = content.match(/contract\s+(\w+)(?:\s+is|\s*{)/)
  if (contractMatch) {
    return contractMatch[1]
  }
  
  // Fallback to filename
  return filename.split('/').pop()?.replace('.sol', '') || 'Unknown'
}

/**
 * Extract functions from Solidity code
 */
function extractFunctions(content: string): string[] {
  const functions: string[] = []
  
  // Match function declarations (public/external)
  const functionRegex = /function\s+(\w+)\s*\([^)]*\)\s+(?:public|external)(?:\s+\w+)*(?:\s+returns\s*\([^)]*\))?/g
  let match
  
  while ((match = functionRegex.exec(content)) !== null) {
    const funcName = match[1]
    // Skip internal utility functions
    if (!funcName.startsWith('_')) {
      functions.push(match[0].trim())
    }
  }
  
  return functions
}

/**
 * Extract events from Solidity code
 */
function extractEvents(content: string): string[] {
  const events: string[] = []
  const eventRegex = /event\s+(\w+)\s*\([^)]*\)/g
  let match
  
  while ((match = eventRegex.exec(content)) !== null) {
    events.push(match[0].trim())
  }
  
  return events
}

/**
 * Extract modifiers from Solidity code
 */
function extractModifiers(content: string): string[] {
  const modifiers: string[] = []
  const modifierRegex = /modifier\s+(\w+)\s*(?:\([^)]*\))?\s*{/g
  let match
  
  while ((match = modifierRegex.exec(content)) !== null) {
    modifiers.push(match[1])
  }
  
  return modifiers
}

/**
 * Extract custom errors from Solidity code
 */
function extractErrors(content: string): string[] {
  const errors: string[] = []
  const errorRegex = /error\s+(\w+)\s*\([^)]*\)/g
  let match
  
  while ((match = errorRegex.exec(content)) !== null) {
    errors.push(match[0].trim())
  }
  
  return errors
}

/**
 * Extract storage variables from Solidity code
 */
function extractStorageVars(content: string): string[] {
  const vars: string[] = []
  
  // Match state variables (simplified - may need refinement)
  const varRegex = /^\s+(?:public|private|internal)?\s+(?:constant)?\s*(\w+(?:\[\])?\s+\w+)\s*(?:=|;)/gm
  let match
  
  while ((match = varRegex.exec(content)) !== null) {
    vars.push(match[1].trim())
  }
  
  return vars
}

/**
 * Compare two arrays and return added/removed items
 */
function compareArrays<T>(oldArr: T[], newArr: T[]): { added: T[]; removed: T[] } {
  const added = newArr.filter(item => !oldArr.includes(item))
  const removed = oldArr.filter(item => !newArr.includes(item))
  return { added, removed }
}

/**
 * Analyze changes in a contract file
 */
function analyzeContractChanges(file: string): ContractAnalysis | null {
  const oldContent = getFileAtCommit(file, 'HEAD~1')
  const newContent = getFileAtCommit(file, 'HEAD')
  
  if (!newContent) {
    console.log(`Skipping ${file} - file deleted or not accessible`)
    return null
  }
  
  const contractName = extractContractName(newContent, file)
  
  // If old content doesn't exist, it's a new file
  if (!oldContent) {
    const functions = extractFunctions(newContent)
    const events = extractEvents(newContent)
    const modifiers = extractModifiers(newContent)
    const errors = extractErrors(newContent)
    const storageVars = extractStorageVars(newContent)
    
    return {
      file,
      contractName,
      functions: { added: functions, removed: [], modified: [] },
      events: { added: events, removed: [] },
      modifiers: { added: modifiers, removed: [] },
      errors: { added: errors, removed: [] },
      storageVars: { added: storageVars, removed: [], modified: [] },
    }
  }
  
  // Compare old and new
  const oldFunctions = extractFunctions(oldContent)
  const newFunctions = extractFunctions(newContent)
  const functionDiff = compareArrays(oldFunctions, newFunctions)
  
  const oldEvents = extractEvents(oldContent)
  const newEvents = extractEvents(newContent)
  const eventDiff = compareArrays(oldEvents, newEvents)
  
  const oldModifiers = extractModifiers(oldContent)
  const newModifiers = extractModifiers(newContent)
  const modifierDiff = compareArrays(oldModifiers, newModifiers)
  
  const oldErrors = extractErrors(oldContent)
  const newErrors = extractErrors(newContent)
  const errorDiff = compareArrays(oldErrors, newErrors)
  
  const oldStorageVars = extractStorageVars(oldContent)
  const newStorageVars = extractStorageVars(newContent)
  const storageDiff = compareArrays(oldStorageVars, newStorageVars)
  
  return {
    file,
    contractName,
    functions: {
      added: functionDiff.added,
      removed: functionDiff.removed,
      modified: [], // TODO: detect signature changes
    },
    events: eventDiff,
    modifiers: modifierDiff,
    errors: errorDiff,
    storageVars: {
      added: storageDiff.added,
      removed: storageDiff.removed,
      modified: [], // TODO: detect type changes
    },
  }
}

/**
 * Generate changelog entry from analysis
 */
function generateChangelogEntry(analyses: ContractAnalysis[]): ChangelogEntry {
  const date = new Date().toISOString().split('T')[0]
  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim() // Full commit hash
  const commitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf-8' }).trim().split('\n')[0]
  
  const entry: ChangelogEntry = {
    date,
    commitSha,
    commitMessage,
    changes: {
      breaking: [],
      added: [],
      changed: [],
      removed: [],
      fixed: [],
    },
  }
  
  for (const analysis of analyses) {
    const contract = `\`${analysis.contractName}\``
    
    // Storage changes are breaking
    if (analysis.storageVars.removed.length > 0 || analysis.storageVars.modified.length > 0) {
      entry.changes.breaking.push(
        `${contract}: Storage layout changed (potential upgrade impact)`
      )
    }
    
    // Function removals are breaking
    if (analysis.functions.removed.length > 0) {
      for (const func of analysis.functions.removed) {
        const funcName = func.match(/function\s+(\w+)/)?.[1] || 'unknown'
        entry.changes.breaking.push(`${contract}: Removed function \`${funcName}\``)
      }
    }
    
    // Additions
    if (analysis.functions.added.length > 0) {
      for (const func of analysis.functions.added) {
        const funcName = func.match(/function\s+(\w+)/)?.[1] || 'unknown'
        entry.changes.added.push(`${contract}: Added function \`${funcName}\``)
      }
    }
    
    if (analysis.events.added.length > 0) {
      for (const event of analysis.events.added) {
        const eventName = event.match(/event\s+(\w+)/)?.[1] || 'unknown'
        entry.changes.added.push(`${contract}: Added event \`${eventName}\``)
      }
    }
    
    if (analysis.errors.added.length > 0) {
      for (const error of analysis.errors.added) {
        const errorName = error.match(/error\s+(\w+)/)?.[1] || 'unknown'
        entry.changes.added.push(`${contract}: Added error \`${errorName}\``)
      }
    }
    
    if (analysis.modifiers.added.length > 0) {
      for (const modifier of analysis.modifiers.added) {
        entry.changes.added.push(`${contract}: Added modifier \`${modifier}\``)
      }
    }
    
    // Removals
    if (analysis.events.removed.length > 0) {
      for (const event of analysis.events.removed) {
        const eventName = event.match(/event\s+(\w+)/)?.[1] || 'unknown'
        entry.changes.removed.push(`${contract}: Removed event \`${eventName}\``)
      }
    }
    
    if (analysis.modifiers.removed.length > 0) {
      for (const modifier of analysis.modifiers.removed) {
        entry.changes.removed.push(`${contract}: Removed modifier \`${modifier}\``)
      }
    }
  }
  
  return entry
}

/**
 * Format changelog entry as Markdown
 */
function formatChangelogEntry(entry: ChangelogEntry): string {
  let markdown = `## [${entry.date}] - ${entry.commitMessage}\n\n`
  markdown += `**Commit**: [\`${entry.commitSha}\`](../../commit/${entry.commitSha})\n\n`
  
  if (entry.changes.breaking.length > 0) {
    markdown += `### ⚠️ Breaking Changes\n\n`
    for (const change of entry.changes.breaking) {
      markdown += `- ${change}\n`
    }
    markdown += '\n'
  }
  
  if (entry.changes.added.length > 0) {
    markdown += `### ✨ Added\n\n`
    for (const change of entry.changes.added) {
      markdown += `- ${change}\n`
    }
    markdown += '\n'
  }
  
  if (entry.changes.changed.length > 0) {
    markdown += `### 🔄 Changed\n\n`
    for (const change of entry.changes.changed) {
      markdown += `- ${change}\n`
    }
    markdown += '\n'
  }
  
  if (entry.changes.removed.length > 0) {
    markdown += `### 🗑️ Removed\n\n`
    for (const change of entry.changes.removed) {
      markdown += `- ${change}\n`
    }
    markdown += '\n'
  }
  
  if (entry.changes.fixed.length > 0) {
    markdown += `### 🐛 Fixed\n\n`
    for (const change of entry.changes.fixed) {
      markdown += `- ${change}\n`
    }
    markdown += '\n'
  }
  
  return markdown
}

/**
 * Update or create changelog file for a specific commit
 */
function updateChangelog(entry: string, commitSha: string): void {
  // Ensure changelog directory exists
  const changelogDir = join(process.cwd(), CHANGELOG_DIR)
  if (!existsSync(changelogDir)) {
    mkdirSync(changelogDir, { recursive: true })
  }
  
  // Create file path: changelog/{commitHash}.md
  const changelogPath = join(changelogDir, `${commitSha}.md`)
  
  // Check if file already exists
  if (existsSync(changelogPath)) {
    console.log(`⚠️  Changelog file already exists for commit ${commitSha.substring(0, 7)}`)
    console.log(`   Skipping to avoid overwriting existing changelog`)
    return
  }
  
  // Generate full changelog content for this commit
  const commitDate = execSync('git log -1 --format=%ci HEAD', { encoding: 'utf-8' }).trim()
  const commitAuthor = execSync('git log -1 --format=%an HEAD', { encoding: 'utf-8' }).trim()
  const commitUrl = process.env.REPOSITORY 
    ? `https://github.com/${process.env.REPOSITORY}/commit/${commitSha}`
    : `#${commitSha}`
  
  const content = `# Contract Changelog - ${commitSha.substring(0, 7)}

**Commit**: [${commitSha}](${commitUrl})  
**Date**: ${commitDate}  
**Author**: ${commitAuthor}

---

${entry}

---

*This changelog was automatically generated for commit ${commitSha}*`
  
  writeFileSync(changelogPath, content, 'utf-8')
  console.log(`✅ Changelog created: ${CHANGELOG_DIR}/${commitSha}.md`)
}

/**
 * Main execution with AI analysis
 */
async function mainWithAI() {
  console.log('🤖 AI-powered analysis mode enabled\n')
  console.log(`Using ${AI_PROVIDER.toUpperCase()} API\n`)
  
  const changedFiles = getChangedSolidityFiles()
  
  if (changedFiles.length === 0) {
    console.log('ℹ️  No Solidity files changed')
    return
  }
  
  console.log(`Found ${changedFiles.length} changed contract(s):\n`)
  changedFiles.forEach(file => console.log(`  - ${file}`))
  console.log()
  
  const date = new Date().toISOString().split('T')[0]
  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim() // Full commit hash
  const commitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf-8' }).trim().split('\n')[0]
  
  let combinedEntry: ChangelogEntry = {
    date,
    commitSha,
    commitMessage,
    changes: {
      breaking: [],
      added: [],
      changed: [],
      removed: [],
      fixed: [],
    },
  }
  
  for (const file of changedFiles) {
    console.log(`\n🔍 Analyzing ${file}...`)
    
    const oldContent = getFileAtCommit(file, 'HEAD~1')
    const newContent = getFileAtCommit(file, 'HEAD')
    
    if (!newContent) {
      console.log(`  ⚠️  Skipped (file deleted or not accessible)`)
      continue
    }
    
    const contractName = extractContractName(newContent, file)
    const diff = getFileDiff(file, 'HEAD~1', 'HEAD')
    
    if (!diff || diff.trim().length === 0) {
      console.log(`  ℹ️  No diff found`)
      continue
    }
    
    try {
      const contractDiff = buildContractDiff(file, contractName, oldContent, newContent, diff)
      const aiAnalysis = await analyzeContractChangesWithAI(contractDiff, undefined, AI_PROVIDER)
      
      console.log(`  ✅ Analysis complete`)
      console.log(`     Summary: ${aiAnalysis.summary}`)
      
      // Merge AI analysis into combined entry
      combinedEntry.changes.breaking.push(...aiAnalysis.breaking)
      combinedEntry.changes.added.push(...aiAnalysis.added)
      combinedEntry.changes.changed.push(...aiAnalysis.changed)
      combinedEntry.changes.removed.push(...aiAnalysis.removed)
      combinedEntry.changes.fixed.push(...aiAnalysis.fixed)
      
      // Add context as a note if present
      if (aiAnalysis.context) {
        combinedEntry.changes.changed.push(`**Note**: ${aiAnalysis.context}`)
      }
    } catch (error: any) {
      console.error(`  ❌ AI analysis failed: ${error.message}`)
      console.log(`  ℹ️  Falling back to basic analysis...`)
      
      // Fallback to basic analysis
      const analysis = analyzeContractChanges(file)
      if (analysis) {
        const basicEntry = generateChangelogEntry([analysis])
        combinedEntry.changes.breaking.push(...basicEntry.changes.breaking)
        combinedEntry.changes.added.push(...basicEntry.changes.added)
        combinedEntry.changes.changed.push(...basicEntry.changes.changed)
        combinedEntry.changes.removed.push(...basicEntry.changes.removed)
        combinedEntry.changes.fixed.push(...basicEntry.changes.fixed)
      }
    }
  }
  
  const formattedEntry = formatChangelogEntry(combinedEntry)
  
  console.log('\n📝 Generated changelog entry:\n')
  console.log(formattedEntry)
  
  updateChangelog(formattedEntry, commitSha)
}

/**
 * Main execution (basic mode)
 */
function main() {
  console.log('🔍 Analyzing contract changes (basic mode)...\n')
  
  const changedFiles = getChangedSolidityFiles()
  
  if (changedFiles.length === 0) {
    console.log('ℹ️  No Solidity files changed')
    return
  }
  
  console.log(`Found ${changedFiles.length} changed contract(s):\n`)
  changedFiles.forEach(file => console.log(`  - ${file}`))
  console.log()
  
  const analyses: ContractAnalysis[] = []
  
  for (const file of changedFiles) {
    const analysis = analyzeContractChanges(file)
    if (analysis) {
      analyses.push(analysis)
    }
  }
  
  if (analyses.length === 0) {
    console.log('ℹ️  No significant changes detected')
    return
  }
  
  const entry = generateChangelogEntry(analyses)
  const formattedEntry = formatChangelogEntry(entry)
  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim() // Full commit hash
  
  console.log('📝 Generated changelog entry:\n')
  console.log(formattedEntry)
  
  updateChangelog(formattedEntry, commitSha)
}

/**
 * Main execution with Advanced AST analysis
 */
async function mainAdvanced() {
  console.log('🔬 Advanced AST analysis mode enabled\n')
  
  const changedFiles = getChangedSolidityFiles()
  
  if (changedFiles.length === 0) {
    console.log('ℹ️  No Solidity files changed')
    return
  }
  
  console.log(`Found ${changedFiles.length} changed contract(s):\n`)
  changedFiles.forEach(file => console.log(`  - ${file}`))
  console.log()
  
  const date = new Date().toISOString().split('T')[0]
  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim() // Full commit hash
  const commitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf-8' }).trim().split('\n')[0]
  
  let combinedEntry: ChangelogEntry = {
    date,
    commitSha,
    commitMessage,
    changes: {
      breaking: [],
      added: [],
      changed: [],
      removed: [],
      fixed: [],
    },
  }
  
  for (const file of changedFiles) {
    console.log(`\n🔍 Analyzing ${file}...`)
    
    const oldContent = getFileAtCommit(file, 'HEAD~1')
    const newContent = getFileAtCommit(file, 'HEAD')
    
    if (!newContent) {
      console.log(`  ⚠️  Skipped (file deleted or not accessible)`)
      continue
    }
    
    try {
      const fileChanges = analyzeContractAdvanced(file, oldContent, newContent)
      
      console.log(`  ✅ Analysis complete`)
      console.log(`     Breaking: ${fileChanges.breaking.length}`)
      console.log(`     Added: ${fileChanges.added.length}`)
      console.log(`     Changed: ${fileChanges.changed.length}`)
      console.log(`     Removed: ${fileChanges.removed.length}`)
      
      // Merge into combined entry
      combinedEntry.changes.breaking.push(...fileChanges.breaking)
      combinedEntry.changes.added.push(...fileChanges.added)
      combinedEntry.changes.changed.push(...fileChanges.changed)
      combinedEntry.changes.removed.push(...fileChanges.removed)
      combinedEntry.changes.fixed.push(...fileChanges.fixed)
    } catch (error: any) {
      console.error(`  ❌ Advanced analysis failed: ${error.message}`)
      console.log(`  ℹ️  Falling back to basic analysis...`)
      
      // Fallback to basic
      const analysis = analyzeContractChanges(file)
      if (analysis) {
        const basicEntry = generateChangelogEntry([analysis])
        combinedEntry.changes.breaking.push(...basicEntry.changes.breaking)
        combinedEntry.changes.added.push(...basicEntry.changes.added)
        combinedEntry.changes.changed.push(...basicEntry.changes.changed)
        combinedEntry.changes.removed.push(...basicEntry.changes.removed)
      }
    }
  }
  
  // Enhance with commit message context
  enhanceWithCommitContext(combinedEntry.changes, execSync('git log -1 --pretty=%B', { encoding: 'utf-8' }).trim())
  
  const formattedEntry = formatChangelogEntry(combinedEntry)
  
  console.log('\n📝 Generated changelog entry:\n')
  console.log(formattedEntry)
  
  updateChangelog(formattedEntry, commitSha)
}

// Run appropriate mode
if (USE_AI) {
  mainWithAI().catch(error => {
    console.error('❌ Error in AI mode:', error)
    console.log('ℹ️  Falling back to advanced mode...')
    mainAdvanced().catch(err => {
      console.error('❌ Advanced mode also failed:', err)
      console.log('ℹ️  Falling back to basic mode...')
      main()
    })
  })
} else if (USE_ADVANCED) {
  mainAdvanced().catch(error => {
    console.error('❌ Error in advanced mode:', error)
    console.log('ℹ️  Falling back to basic mode...')
    main()
  })
} else {
  main()
}
