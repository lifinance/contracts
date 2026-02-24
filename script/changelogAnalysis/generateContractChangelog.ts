#!/usr/bin/env bun

/**
 * Contract Changelog Generator
 *
 * Analyzes Solidity contract changes and generates changelog entries using
 * Claude Sonnet (Anthropic API). Requires CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY.
 * Changelog test: demo change in .ts (not included in contract changelog).
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  analyzeContractChangesWithAI,
  buildContractDiff,
  getFileDiff,
} from './aiChangelogAnalyzer'

const CHANGELOG_DIR = 'changelog'
const CONTRACTS_CHANGELOG_DIR = join(CHANGELOG_DIR, 'contracts')
const MAIN_CHANGELOG_FILE = 'CHANGELOG.md'
const CONTRACTS_DIR = 'src'

const CHANGELOG_HEADER = `# Contract Changelog

All contract changes by commit (newest first). Per-contract history: \`changelog/contracts/{ContractName}.md\`.

`

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

/** Format change sections (### Breaking, Added, etc.) for a single contract. */
function formatContractSections(analysis: {
  breaking: string[]
  added: string[]
  changed: string[]
  removed: string[]
  fixed: string[]
  context?: string
}): string {
  const parts: string[] = []
  if (analysis.breaking.length > 0) {
    parts.push('### ⚠️ Breaking Changes\n\n' + analysis.breaking.map((c) => `- ${c}`).join('\n'))
  }
  if (analysis.added.length > 0) {
    parts.push('### ✨ Added\n\n' + analysis.added.map((c) => `- ${c}`).join('\n'))
  }
  if (analysis.changed.length > 0) {
    parts.push('### 🔄 Changed\n\n' + analysis.changed.map((c) => `- ${c}`).join('\n'))
  }
  if (analysis.removed.length > 0) {
    parts.push('### 🗑️ Removed\n\n' + analysis.removed.map((c) => `- ${c}`).join('\n'))
  }
  if (analysis.fixed.length > 0) {
    parts.push('### 🐛 Fixed\n\n' + analysis.fixed.map((c) => `- ${c}`).join('\n'))
  }
  if (analysis.context) {
    parts.push('**Note**: ' + analysis.context)
  }
  return parts.join('\n\n')
}

/**
 * Prepend this commit's full entry to changelog/CHANGELOG.md.
 * Skips if this commit is already present. Ordered by commit (newest first).
 */
function updateChangelog(entry: string, commitSha: string): void {
  const changelogRoot = join(process.cwd(), CHANGELOG_DIR)
  if (!existsSync(changelogRoot)) {
    mkdirSync(changelogRoot, { recursive: true })
  }
  const changelogPath = join(changelogRoot, MAIN_CHANGELOG_FILE)
  const commitDate = execSync('git log -1 --format=%ci HEAD', { encoding: 'utf-8' }).trim()
  const commitAuthor = execSync('git log -1 --format=%an HEAD', { encoding: 'utf-8' }).trim()
  const commitUrl = process.env.REPOSITORY
    ? `https://github.com/${process.env.REPOSITORY}/commit/${commitSha}`
    : `#${commitSha}`
  const firstLine = entry.split('\n')[0] ?? ''
  const commitMessage = firstLine.replace(/^## \[[^\]]*\] - /, '').trim() || 'Contract changes'
  const sections = entry.split('\n').slice(4).join('\n').trim()

  const block = `## [${commitSha.substring(0, 7)}] - ${commitMessage}

**Commit**: [\`${commitSha}\`](${commitUrl})  
**Date**: ${commitDate}  
**Author**: ${commitAuthor}

${sections}

---
`

  if (existsSync(changelogPath)) {
    const current = readFileSync(changelogPath, 'utf-8')
    if (current.includes(commitSha)) {
      console.log(`⚠️  Commit ${commitSha.substring(0, 7)} already in ${CHANGELOG_DIR}/${MAIN_CHANGELOG_FILE}, skipping`)
      return
    }
    const body = current.startsWith(CHANGELOG_HEADER)
      ? current.slice(CHANGELOG_HEADER.length).trim()
      : current.trim()
    writeFileSync(changelogPath, CHANGELOG_HEADER + block + (body ? '\n\n' + body : ''), 'utf-8')
  } else {
    writeFileSync(changelogPath, CHANGELOG_HEADER + block.trimEnd(), 'utf-8')
  }
  console.log(`✅ Updated ${CHANGELOG_DIR}/${MAIN_CHANGELOG_FILE}`)
}

/**
 * Prepend this commit's changes for one contract to changelog/contracts/{ContractName}.md.
 * Lists commit hash and change sections; newest first.
 */
function updateContractChangelog(
  contractName: string,
  commitSha: string,
  commitMessage: string,
  commitDate: string,
  sections: string
): void {
  const contractsDir = join(process.cwd(), CONTRACTS_CHANGELOG_DIR)
  if (!existsSync(contractsDir)) {
    mkdirSync(contractsDir, { recursive: true })
  }
  const safeName = contractName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const filePath = join(contractsDir, `${safeName}.md`)
  const commitUrl = process.env.REPOSITORY
    ? `https://github.com/${process.env.REPOSITORY}/commit/${commitSha}`
    : `#${commitSha}`
  const commitAuthor = execSync('git log -1 --format=%an HEAD', { encoding: 'utf-8' }).trim()

  const block = `## [${commitSha.substring(0, 7)}] - ${commitMessage}

**Commit**: [\`${commitSha}\`](${commitUrl})  
**Date**: ${commitDate}  
**Author**: ${commitAuthor}

${sections}

---
`

  const header = `# ${contractName} – Changelog

Commits that modified this contract (newest first).

`
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf-8')
    if (current.includes(commitSha)) {
      return
    }
    const body = current.startsWith(header) ? current.slice(header.length).trim() : current.trim()
    writeFileSync(filePath, header + block + (body ? '\n\n' + body : ''), 'utf-8')
  } else {
    writeFileSync(filePath, header + block.trimEnd(), 'utf-8')
  }
  console.log(`✅ Updated ${CONTRACTS_CHANGELOG_DIR}/${safeName}.md`)
}

/**
 * Main execution with AI analysis
 */
async function mainWithAI() {
  console.log('🤖 AI-powered analysis (Claude Sonnet)\n')
  
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
  const commitDate = execSync('git log -1 --format=%ci HEAD', { encoding: 'utf-8' }).trim()

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
  const perContract: Array<{ contractName: string; aiAnalysis: Awaited<ReturnType<typeof analyzeContractChangesWithAI>> }> = []

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
    perContract.push({ contractName, aiAnalysis })
  }
  
  const formattedEntry = formatChangelogEntry(combinedEntry)
  
  console.log('\n📝 Generated changelog entry:\n')
  console.log(formattedEntry)
  
  updateChangelog(formattedEntry, commitSha)
  for (const { contractName, aiAnalysis } of perContract) {
    updateContractChangelog(
      contractName,
      commitSha,
      commitMessage,
      commitDate,
      formatContractSections(aiAnalysis)
    )
  }
}

mainWithAI().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Changelog generation failed:', message)
  process.exit(1)
})
