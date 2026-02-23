#!/usr/bin/env bun

/**
 * Contract Changelog Generator
 *
 * Analyzes Solidity contract changes and generates changelog entries using AI
 * (CodeRabbit) for semantic descriptions.
 * Changelog test: demo change in .ts (not included in contract changelog).
 */

import { execSync } from 'child_process'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  analyzeContractChangesWithAI,
  buildContractDiff,
  getFileDiff,
} from './aiChangelogAnalyzer'

const CHANGELOG_DIR = 'changelog'
const CONTRACTS_DIR = 'src'

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
    return contractMatch[1] ?? 'Unknown'
  }
  
  // Fallback to filename
  return filename.split('/').pop()?.replace('.sol', '') || 'Unknown'
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
  console.log('🤖 AI-powered analysis (CodeRabbit)\n')
  
  const changedFiles = getChangedSolidityFiles()
  
  if (changedFiles.length === 0) {
    console.log('ℹ️  No Solidity files changed')
    return
  }
  
  console.log(`Found ${changedFiles.length} changed contract(s):\n`)
  changedFiles.forEach(file => console.log(`  - ${file}`))
  console.log()
  
  const date = new Date().toISOString().split('T')[0] ?? ''
  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
  const commitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf-8' }).trim().split('\n')[0] ?? ''

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
    
    const contractDiff = buildContractDiff(file, contractName, oldContent, newContent, diff)
    const aiAnalysis = await analyzeContractChangesWithAI(contractDiff)

    console.log(`  ✅ Analysis complete`)
    console.log(`     Summary: ${aiAnalysis.summary}`)

    combinedEntry.changes.breaking.push(...aiAnalysis.breaking)
    combinedEntry.changes.added.push(...aiAnalysis.added)
    combinedEntry.changes.changed.push(...aiAnalysis.changed)
    combinedEntry.changes.removed.push(...aiAnalysis.removed)
    combinedEntry.changes.fixed.push(...aiAnalysis.fixed)

    if (aiAnalysis.context) {
      combinedEntry.changes.changed.push(`**Note**: ${aiAnalysis.context}`)
    }
  }
  
  const formattedEntry = formatChangelogEntry(combinedEntry)
  
  console.log('\n📝 Generated changelog entry:\n')
  console.log(formattedEntry)
  
  updateChangelog(formattedEntry, commitSha)
}

mainWithAI().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Changelog generation failed:', message)
  process.exit(1)
})
