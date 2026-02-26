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
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import {
  analyzeContractChangesWithAI,
  buildContractDiff,
  getFileDiff,
} from './aiChangelogAnalyzer'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Repo root; changelog files are written to <repo_root>/changelog/ */
const REPO_ROOT = join(__dirname, '..', '..')
const CHANGELOG_OUTPUT_ROOT = REPO_ROOT

const CHANGELOG_DIR = 'changelog'
const CONTRACTS_CHANGELOG_DIR = join(CHANGELOG_DIR, 'contracts')
const MAIN_CHANGELOG_FILE = 'CHANGELOG.md'
const CONTRACTS_DIR = 'src'

const CHANGELOG_HEADER = `# Contract Changelog

Contract changes grouped by version (from \`@custom:version\`). Per-contract history: \`changelog/contracts/{ContractName}.md\`.

`

/** Aggregated changes for one contract version (one section in the changelog) */
interface IVersionedEntry {
  contractName: string
  version: string
  commitShas: string[]
  latestDate: string
  changes: {
    breaking: string[]
    added: string[]
    changed: string[]
    removed: string[]
    fixed: string[]
  }
}

/**
 * Get changed Solidity files for a given commit (or HEAD if not specified).
 * Uses COMMIT_SHA from env when set (workflow passes the commit that triggered the run).
 */
function getChangedSolidityFiles(commitSha?: string): string[] {
  const target = commitSha ?? 'HEAD'
  const parent = commitSha ? `${commitSha}^` : 'HEAD~1'
  try {
    const output = execSync(`git diff --name-only ${parent} ${target}`, {
      encoding: 'utf-8',
    })
    return output
      .split('\n')
      .filter((file) => file.startsWith(CONTRACTS_DIR) && file.endsWith('.sol'))
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
 * Return true if a line of Solidity is purely a comment / NatSpec.
 * Expects the line to already be trimmed (no leading/trailing whitespace).
 */
function isCommentLine(content: string): boolean {
  if (content === '') {
    return true
  }

  // Single-line and NatSpec comments (including @custom:version – only real code changes trigger changelog)
  if (content.startsWith('//') || content.startsWith('///')) {
    return true
  }

  // Block comment lines (including NatSpec-style /** ... */ blocks)
  if (content.startsWith('/*') || content.startsWith('/**')) {
    return true
  }
  if (content.startsWith('*') || content.endsWith('*/')) {
    return true
  }

  return false
}

/**
 * Detect whether a unified diff contains only comment changes.
 * We ignore metadata lines (diff/index/@@/---/+++), and only inspect
 * added/removed lines that start with '+' or '-'.
 */
function isCommentOnlyDiff(diff: string): boolean {
  const lines = diff.split('\n')
  for (const line of lines) {
    if (!line.startsWith('+') && !line.startsWith('-')) {
      continue
    }
    // Skip file headers like +++/--- which also start with those chars
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue
    }

    const content = line.slice(1).trim()
    if (content === '') {
      continue
    }

    // If any changed line is not a pure comment, this is not comment-only
    if (!isCommentLine(content)) {
      return false
    }
  }

  // No non-comment changes found
  return true
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

/** Match @custom:version X.Y.Z or custom::version X.Y.Z in NatSpec/comments */
const VERSION_REGEX = /(?:@custom:version|custom::version)\s+(\d+\.\d+\.\d+)/i

function extractVersion(content: string): string | null {
  const m = content.match(VERSION_REGEX)
  return m ? m[1] ?? null : null
}

/**
 * Commits to analyze: for a merge commit (e.g. PR merge), all commits in the branch; otherwise the single commit.
 */
function getCommitsToAnalyze(commitSha: string): string[] {
  try {
    const parentRef = `${commitSha}^@`
    const parents = execSync(`git rev-parse ${parentRef}`, { encoding: 'utf-8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (parents.length >= 2) {
      // Merge commit: first parent = base (e.g. main), second = branch tip
      const list = execSync(`git rev-list --reverse ${parents[0]}..${parents[1]}`, {
        encoding: 'utf-8',
      })
        .trim()
        .split('\n')
        .filter(Boolean)
      return list.length > 0 ? list : [commitSha]
    }
  } catch {
    // Fallback to single commit
  }
  return [commitSha]
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

function commitUrl(sha: string): string {
  return process.env.REPOSITORY
    ? `https://github.com/${process.env.REPOSITORY}/commit/${sha}`
    : `#${sha}`
}

/** Format one versioned section (header = contract version, combined changes from all commits). */
function formatVersionedSection(entry: IVersionedEntry): string {
  const commitLinks = entry.commitShas
    .map((sha) => `[\`${sha.substring(0, 7)}\`](${commitUrl(sha)})`)
    .join(', ')
  let out = `### ${entry.contractName} v${entry.version}\n\n`
  out += `**Commits**: ${commitLinks}\n\n`
  out += `**Date**: ${entry.latestDate}\n\n`
  out += formatContractSections(entry.changes)
  return out
}

/** Format one version section for a per-contract changelog (header = vX.Y.Z). */
function formatContractVersionSection(
  version: string,
  commitShas: string[],
  latestDate: string,
  sections: string
): string {
  const commitLinks = commitShas
    .map((sha) => `[\`${sha.substring(0, 7)}\`](${commitUrl(sha)})`)
    .join(', ')
  return `## v${version}

**Commits**: ${commitLinks}  
**Date**: ${latestDate}

${sections}

---
`
}

/**
 * Prepend one versioned block (all contract versions in this run) to changelog/CHANGELOG.md.
 * Skips if commitSha is already present.
 */
function updateChangelogVersioned(entries: IVersionedEntry[], commitSha: string): void {
  const changelogRoot = join(CHANGELOG_OUTPUT_ROOT, CHANGELOG_DIR)
  if (!existsSync(changelogRoot)) {
    mkdirSync(changelogRoot, { recursive: true })
  }
  const changelogPath = join(changelogRoot, MAIN_CHANGELOG_FILE)
  const commitDate = execSync('git log -1 --format=%ci HEAD', { encoding: 'utf-8' }).trim()
  const url = commitUrl(commitSha)
  const versionBlock = entries.map((e) => formatVersionedSection(e)).join('\n\n')
  const block = `## [${commitSha.substring(0, 7)}] - Contract version updates

**Commit**: [\`${commitSha}\`](${url})  
**Date**: ${commitDate}

${versionBlock}

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
 * Prepend versioned sections for one contract to changelog/contracts/{ContractName}.md.
 * One section per version (newest first); skips if any of the entries' commits are already in the file.
 */
function updateContractChangelogVersioned(
  contractName: string,
  entries: IVersionedEntry[]
): void {
  const contractsDir = join(CHANGELOG_OUTPUT_ROOT, CONTRACTS_CHANGELOG_DIR)
  if (!existsSync(contractsDir)) {
    mkdirSync(contractsDir, { recursive: true })
  }
  const safeName = contractName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const filePath = join(contractsDir, `${safeName}.md`)
  const allShas = entries.flatMap((e) => e.commitShas)
  const header = `# ${contractName} – Changelog

Changes grouped by contract version (\`@custom:version\`).

`
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf-8')
    if (allShas.some((sha) => current.includes(sha))) {
      return
    }
    const body = current.startsWith(header) ? current.slice(header.length).trim() : current.trim()
    const sections = entries
      .sort((a, b) => compareVersion(b.version, a.version))
      .map((e) =>
        formatContractVersionSection(
          e.version,
          e.commitShas,
          e.latestDate,
          formatContractSections(e.changes)
        )
      )
      .join('\n\n')
    writeFileSync(filePath, header + sections + (body ? '\n\n' + body : ''), 'utf-8')
  } else {
    const sections = entries
      .sort((a, b) => compareVersion(b.version, a.version))
      .map((e) =>
        formatContractVersionSection(
          e.version,
          e.commitShas,
          e.latestDate,
          formatContractSections(e.changes)
        )
      )
      .join('\n\n')
    writeFileSync(filePath, header + sections.trimEnd(), 'utf-8')
  }
  console.log(`✅ Updated ${CONTRACTS_CHANGELOG_DIR}/${safeName}.md`)
}

/** Compare semver strings (a, b) -> negative if a < b, 0 if equal, positive if a > b */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va - vb
  }
  return 0
}

/**
 * Main execution with AI analysis. Groups changes by contract version (@custom:version).
 * For merge commits, analyzes all commits in the branch and aggregates by version.
 */
async function mainWithAI() {
  console.log('🤖 AI-powered analysis (Claude Sonnet)\n')
  console.log(`Changelog output dir: ${join(CHANGELOG_OUTPUT_ROOT, CHANGELOG_DIR)}\n`)
  const commitSha =
    process.env.COMMIT_SHA?.trim() ||
    execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
  const commitsToAnalyze = getCommitsToAnalyze(commitSha)
  console.log(`Analyzing ${commitsToAnalyze.length} commit(s) (trigger: ${commitSha.substring(0, 7)})\n`)

  /** key: "contractName|version" -> aggregated entry */
  const byContractAndVersion = new Map<string, IVersionedEntry>()

  for (const c of commitsToAnalyze) {
    const parentCommit = `${c}^`
    const changedFiles = getChangedSolidityFiles(c)
    const commitDate = execSync(`git log -1 --format=%ci ${c}`, { encoding: 'utf-8' }).trim()

    for (const file of changedFiles) {
      const oldContent = getFileAtCommit(file, parentCommit)
      const newContent = getFileAtCommit(file, c)
      if (!newContent) continue
      const contractName = extractContractName(newContent, file)
      const version = extractVersion(newContent) ?? 'unknown'
      const key = `${contractName}|${version}`

      const diff = getFileDiff(file, parentCommit, c)
      if (!diff?.trim() || isCommentOnlyDiff(diff)) continue

      console.log(`\n🔍 ${file} @ ${c.substring(0, 7)} (${contractName} v${version})`)
      const contractDiff = buildContractDiff(file, contractName, oldContent, newContent, diff)
      const aiAnalysis = await analyzeContractChangesWithAI(contractDiff)
      console.log(`  ✅ ${aiAnalysis.summary}`)

      let entry = byContractAndVersion.get(key)
      if (!entry) {
        entry = {
          contractName,
          version,
          commitShas: [],
          latestDate: commitDate,
          changes: {
            breaking: [],
            added: [],
            changed: [],
            removed: [],
            fixed: [],
          },
        }
        byContractAndVersion.set(key, entry)
      }
      entry.commitShas.push(c)
      if (commitDate > entry.latestDate) entry.latestDate = commitDate
      entry.changes.breaking.push(...aiAnalysis.breaking)
      entry.changes.added.push(...aiAnalysis.added)
      entry.changes.changed.push(...aiAnalysis.changed)
      entry.changes.removed.push(...aiAnalysis.removed)
      entry.changes.fixed.push(...aiAnalysis.fixed)
      if (aiAnalysis.context) {
        entry.changes.changed.push(`**Note**: ${aiAnalysis.context}`)
      }
    }
  }

  const entries = Array.from(byContractAndVersion.values())
  if (entries.length === 0) {
    console.log('ℹ️  No code-level contract changes (only comments/formatting or no .sol changes)')
    return
  }

  const hasAnyChanges = entries.some(
    (e) =>
      e.changes.breaking.length > 0 ||
      e.changes.added.length > 0 ||
      e.changes.changed.length > 0 ||
      e.changes.removed.length > 0 ||
      e.changes.fixed.length > 0
  )
  if (!hasAnyChanges) {
    console.log('ℹ️  No code-level contract changes; skipping changelog update')
    return
  }

  console.log('\n📝 Generated changelog (by version):\n')
  entries.forEach((e) => console.log(`  - ${e.contractName} v${e.version}`))

  updateChangelogVersioned(entries, commitSha)
  const byContract = new Map<string, IVersionedEntry[]>()
  for (const e of entries) {
    const list = byContract.get(e.contractName) ?? []
    list.push(e)
    byContract.set(e.contractName, list)
  }
  for (const [contractName, versionEntries] of byContract) {
    updateContractChangelogVersioned(contractName, versionEntries)
  }
}

mainWithAI().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Changelog generation failed:', message)
  process.exit(1)
})
