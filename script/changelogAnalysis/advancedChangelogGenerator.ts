/**
 * Advanced Changelog Generator (AST-based)
 * 
 * Uses AST analysis, Forge inspection, and semantic inference
 * to generate high-quality changelogs without AI
 */

import { execSync } from 'child_process'
import {
  parseContractAST,
  formatFunctionSignature,
  formatEventSignature,
  type ContractAST,
  type FunctionInfo,
} from './astAnalyzer'
import {
  inspectContractWithForge,
  compareStorageLayouts,
  compareABIs,
  estimateGasImpact,
} from './forgeAnalyzer'
import {
  inferFunctionAddition,
  inferFunctionRemoval,
  inferFunctionModification,
  inferEventAddition,
  inferStorageChange,
  parseCommitMessage,
  isBreakingChange,
} from './semanticInference'

export interface AdvancedChangelogEntry {
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
  metadata: {
    filesChanged: number
    analysisMode: 'AST' | 'Forge' | 'Hybrid'
    gasImpact?: string
  }
}

/**
 * Get file content at specific commit
 */
function getFileAtCommit(file: string, commit: string): string | null {
  try {
    return execSync(`git show ${commit}:${file}`, { encoding: 'utf-8' })
  } catch {
    return null
  }
}

/**
 * Extract contract name from Solidity file
 */
function extractContractName(content: string, filename: string): string {
  const match = content.match(/contract\s+(\w+)(?:\s+is|\s*{)/)
  return match ? match[1] : filename.split('/').pop()?.replace('.sol', '') || 'Unknown'
}

/**
 * Analyze single contract file with advanced techniques
 */
export function analyzeContractAdvanced(
  file: string,
  oldContent: string | null,
  newContent: string
): AdvancedChangelogEntry['changes'] {
  const changes = {
    breaking: [] as string[],
    added: [] as string[],
    changed: [] as string[],
    removed: [] as string[],
    fixed: [] as string[],
  }
  
  const contractName = extractContractName(newContent, file)
  
  // Try AST analysis first
  const oldAST = oldContent ? parseContractAST(oldContent, file) : null
  const newAST = parseContractAST(newContent, file)
  
  if (newAST && oldAST) {
    // AST-based analysis (most accurate)
    analyzeWithAST(oldAST, newAST, contractName, changes)
  } else {
    // Fallback to regex-based analysis
    console.log(`  Using regex-based analysis (AST not available)`)
    return analyzeWithRegex(file, oldContent, newContent)
  }
  
  // Try Forge analysis for storage layout
  try {
    const oldForge = oldContent ? inspectContractWithForge(file, contractName) : null
    const newForge = inspectContractWithForge(file, contractName)
    
    if (oldForge && newForge) {
      const storageComparison = compareStorageLayouts(
        oldForge.storageLayout,
        newForge.storageLayout
      )
      
      if (storageComparison.isBreaking) {
        changes.breaking.push(
          `\`${contractName}\`: ${storageComparison.changes.join('; ')}`
        )
      }
      
      // Gas impact analysis
      const gasImpact = estimateGasImpact(oldForge.storageLayout, newForge.storageLayout)
      if (gasImpact.impact !== 'none' && gasImpact.description) {
        changes.changed.push(`\`${contractName}\`: ${gasImpact.description}`)
      }
    }
  } catch (error) {
    // Forge analysis is optional
    console.warn(`Forge analysis failed for ${file}:`, error)
  }
  
  return changes
}

/**
 * Analyze contract changes using AST
 */
function analyzeWithAST(
  oldAST: ContractAST | null,
  newAST: ContractAST,
  contractName: string,
  changes: AdvancedChangelogEntry['changes']
): void {
  // New contract (all additions)
  if (!oldAST) {
    for (const func of newAST.functions) {
      const inference = inferFunctionAddition(func)
      const signature = formatFunctionSignature(func)
      let description = `\`${contractName}\`: ${inference.shortDescription.replace('Added function', `Added \`${signature}\``)}`
      
      if (inference.context) {
        description += ` ${inference.context}`
      }
      if (inference.securityNote) {
        description += ` (${inference.securityNote})`
      }
      
      changes.added.push(description)
    }
    
    for (const event of newAST.events) {
      const inference = inferEventAddition(event)
      changes.added.push(`\`${contractName}\`: ${inference.shortDescription}`)
    }
    
    return
  }
  
  // Compare functions
  const oldFuncMap = new Map(oldAST.functions.map(f => [f.name, f]))
  const newFuncMap = new Map(newAST.functions.map(f => [f.name, f]))
  
  // Added functions
  for (const [name, func] of newFuncMap) {
    if (!oldFuncMap.has(name)) {
      const inference = inferFunctionAddition(func)
      const signature = formatFunctionSignature(func)
      let description = `\`${contractName}\`: Added \`${signature}\``
      
      if (inference.context) {
        description += ` ${inference.context}`
      }
      if (inference.securityNote) {
        description += ` (${inference.securityNote})`
      }
      
      changes.added.push(description)
    }
  }
  
  // Removed functions
  for (const [name, func] of oldFuncMap) {
    if (!newFuncMap.has(name)) {
      const inference = inferFunctionRemoval(func)
      let description = `\`${contractName}\`: ${inference.shortDescription}`
      
      if (inference.context) {
        description += ` (${inference.context})`
      }
      
      changes.breaking.push(description)
    }
  }
  
  // Modified functions
  for (const [name, newFunc] of newFuncMap) {
    const oldFunc = oldFuncMap.get(name)
    if (oldFunc) {
      // Check if signature changed
      const oldSig = formatFunctionSignature(oldFunc)
      const newSig = formatFunctionSignature(newFunc)
      
      if (oldSig !== newSig || oldFunc.modifiers.length !== newFunc.modifiers.length) {
        const inference = inferFunctionModification(oldFunc, newFunc)
        let description = `\`${contractName}\`: ${inference.shortDescription}`
        
        if (oldSig !== newSig) {
          description += ` - signature changed from \`${oldSig}\` to \`${newSig}\``
        }
        
        if (inference.context) {
          description += ` (${inference.context})`
        }
        
        if (isBreakingChange(oldFunc, newFunc)) {
          changes.breaking.push(description)
        } else {
          changes.changed.push(description)
        }
        
        if (inference.securityNote) {
          changes.changed.push(`\`${contractName}\`: ${inference.securityNote}`)
        }
      }
    }
  }
  
  // Compare events
  const oldEventNames = new Set(oldAST.events.map(e => e.name))
  const newEventNames = new Set(newAST.events.map(e => e.name))
  
  for (const event of newAST.events) {
    if (!oldEventNames.has(event.name)) {
      const inference = inferEventAddition(event)
      const signature = formatEventSignature(event)
      let description = `\`${contractName}\`: Added event \`${signature}\``
      
      if (inference.context) {
        description += ` ${inference.context}`
      }
      
      changes.added.push(description)
    }
  }
  
  for (const event of oldAST.events) {
    if (!newEventNames.has(event.name)) {
      changes.removed.push(`\`${contractName}\`: Removed event \`${event.name}\``)
    }
  }
  
  // Compare errors
  const oldErrorNames = new Set(oldAST.errors.map(e => e.name))
  const newErrorNames = new Set(newAST.errors.map(e => e.name))
  
  for (const error of newAST.errors) {
    if (!oldErrorNames.has(error.name)) {
      changes.added.push(`\`${contractName}\`: Added custom error \`${error.name}\``)
    }
  }
  
  // Compare modifiers
  const oldModifierNames = new Set(oldAST.modifiers)
  const newModifierNames = new Set(newAST.modifiers)
  
  for (const modifier of newModifierNames) {
    if (!oldModifierNames.has(modifier)) {
      changes.added.push(`\`${contractName}\`: Added modifier \`${modifier}\``)
    }
  }
  
  for (const modifier of oldModifierNames) {
    if (!newModifierNames.has(modifier)) {
      changes.removed.push(`\`${contractName}\`: Removed modifier \`${modifier}\``)
    }
  }
}

/**
 * Regex-based analysis fallback
 */
function analyzeWithRegex(
  file: string,
  oldContent: string | null,
  newContent: string
): AdvancedChangelogEntry['changes'] {
  const changes = {
    breaking: [] as string[],
    added: [] as string[],
    changed: [] as string[],
    removed: [] as string[],
    fixed: [] as string[],
  }
  
  const contractName = extractContractName(newContent, file)
  
  // Extract functions
  const oldFunctions = oldContent ? extractFunctions(oldContent) : []
  const newFunctions = extractFunctions(newContent)
  
  // Find added functions
  for (const func of newFunctions) {
    if (!oldFunctions.includes(func)) {
      const match = func.match(/function\s+(\w+)/)
      if (match) {
        changes.added.push(`\`${contractName}\`: Added function \`${match[1]}\``)
      }
    }
  }
  
  // Find removed functions
  for (const func of oldFunctions) {
    if (!newFunctions.includes(func)) {
      const match = func.match(/function\s+(\w+)/)
      if (match) {
        changes.breaking.push(`\`${contractName}\`: Removed function \`${match[1]}\``)
      }
    }
  }
  
  // Extract events
  const oldEvents = oldContent ? extractEvents(oldContent) : []
  const newEvents = extractEvents(newContent)
  
  for (const event of newEvents) {
    if (!oldEvents.includes(event)) {
      const match = event.match(/event\s+(\w+)/)
      if (match) {
        changes.added.push(`\`${contractName}\`: Added event \`${match[1]}\``)
      }
    }
  }
  
  return changes
}

function extractFunctions(content: string): string[] {
  const functions: string[] = []
  const functionRegex = /function\s+(\w+)\s*\([^)]*\)\s+(?:public|external)(?:\s+\w+)*(?:\s+returns\s*\([^)]*\))?/g
  let match
  while ((match = functionRegex.exec(content)) !== null) {
    functions.push(match[0])
  }
  return functions
}

function extractEvents(content: string): string[] {
  const events: string[] = []
  const eventRegex = /event\s+(\w+)\s*\([^)]*\)/g
  let match
  while ((match = eventRegex.exec(content)) !== null) {
    events.push(match[0])
  }
  return events
}

/**
 * Enhance changelog with commit message context
 */
export function enhanceWithCommitContext(
  changes: AdvancedChangelogEntry['changes'],
  commitMessage: string
): void {
  const parsed = parseCommitMessage(commitMessage)
  
  // If commit type is 'fix' and no fixes detected, add generic entry
  if (parsed.type === 'fix' && changes.fixed.length === 0 && changes.changed.length > 0) {
    const firstChange = changes.changed[0]
    changes.fixed.push(firstChange)
    changes.changed.shift()
  }
  
  // Add commit body as context if meaningful
  if (parsed.body && parsed.body.length > 20 && parsed.body.length < 200) {
    // Check if body adds useful context
    const keywords = ['breaking', 'migration', 'upgrade', 'security', 'vulnerability']
    if (keywords.some(k => parsed.body!.toLowerCase().includes(k))) {
      changes.changed.push(`**Context**: ${parsed.body}`)
    }
  }
}
