/**
 * Semantic Inference Engine
 * 
 * Infers meaning and context from code changes using heuristics
 */

import type { FunctionInfo, EventInfo, StateVarInfo } from './astAnalyzer'

export interface SemanticDescription {
  shortDescription: string
  context?: string
  securityNote?: string
  breakingNote?: string
}

/**
 * Infer semantic description for added function
 */
export function inferFunctionAddition(func: FunctionInfo): SemanticDescription {
  const result: SemanticDescription = {
    shortDescription: `Added function \`${func.name}\``,
  }
  
  // Check for batch operations
  if (func.name.toLowerCase().includes('batch')) {
    result.context = 'for gas-efficient batch operations'
  }
  
  // Check for security modifiers
  const securityModifiers = func.modifiers.filter(m => 
    ['nonReentrant', 'whenNotPaused', 'onlyOwner', 'onlyRole'].some(sm => m.includes(sm))
  )
  
  if (securityModifiers.length > 0) {
    result.securityNote = `Protected by: ${securityModifiers.join(', ')}`
  }
  
  // Check for payable
  if (func.stateMutability === 'payable') {
    result.context = result.context 
      ? `${result.context}, accepts ETH payments`
      : 'accepts ETH payments'
  }
  
  // Check for view/pure
  if (func.stateMutability === 'view' || func.stateMutability === 'pure') {
    result.context = result.context
      ? `${result.context}, read-only query`
      : 'read-only query function'
  }
  
  // Check for admin functions
  if (func.modifiers.some(m => m.includes('onlyOwner') || m.includes('onlyAdmin'))) {
    result.context = result.context
      ? `${result.context}, admin-only`
      : 'admin-only operation'
  }
  
  // Check function purpose by name patterns
  const purposePatterns = {
    transfer: 'for token transfers',
    withdraw: 'for withdrawing funds',
    deposit: 'for depositing funds',
    swap: 'for token swaps',
    bridge: 'for cross-chain bridging',
    stake: 'for staking tokens',
    claim: 'for claiming rewards',
    approve: 'for token approvals',
    execute: 'for executing operations',
    update: 'for updating configuration',
    set: 'for configuration changes',
    get: 'for retrieving data',
    check: 'for validation checks',
    calculate: 'for calculations',
  }
  
  for (const [pattern, purpose] of Object.entries(purposePatterns)) {
    if (func.name.toLowerCase().includes(pattern)) {
      result.context = result.context
        ? `${result.context}, ${purpose}`
        : purpose
      break
    }
  }
  
  // Use NatSpec documentation if available
  if (func.documentation) {
    const cleanDoc = func.documentation.replace(/\n/g, ' ').trim()
    if (cleanDoc.length > 0 && cleanDoc.length < 150) {
      result.shortDescription = `Added \`${func.name}\`: ${cleanDoc}`
      return result
    }
  }
  
  return result
}

/**
 * Infer semantic description for function removal
 */
export function inferFunctionRemoval(func: FunctionInfo): SemanticDescription {
  const result: SemanticDescription = {
    shortDescription: `Removed function \`${func.name}\``,
  }
  
  // Check if it's a deprecated function
  if (func.name.toLowerCase().includes('old') || 
      func.name.toLowerCase().includes('deprecated') ||
      func.name.toLowerCase().includes('legacy')) {
    result.context = 'deprecated function cleanup'
  }
  
  // Check if V1/V2 pattern (migration)
  if (func.name.match(/v\d+$/i)) {
    result.context = 'superseded by newer version'
  }
  
  result.breakingNote = 'Breaking change: function no longer available'
  
  return result
}

/**
 * Infer semantic description for function modification
 */
export function inferFunctionModification(
  oldFunc: FunctionInfo, 
  newFunc: FunctionInfo
): SemanticDescription {
  const result: SemanticDescription = {
    shortDescription: `Modified function \`${newFunc.name}\``,
  }
  
  // Check parameter changes
  if (oldFunc.params.length !== newFunc.params.length) {
    const diff = newFunc.params.length - oldFunc.params.length
    if (diff > 0) {
      result.context = `added ${diff} parameter(s)`
      result.breakingNote = 'Signature change: existing calls must be updated'
    } else {
      result.context = `removed ${Math.abs(diff)} parameter(s)`
      result.breakingNote = 'Breaking change: signature simplified'
    }
  }
  
  // Check modifier changes
  const addedModifiers = newFunc.modifiers.filter(m => !oldFunc.modifiers.includes(m))
  const removedModifiers = oldFunc.modifiers.filter(m => !newFunc.modifiers.includes(m))
  
  if (addedModifiers.length > 0) {
    const securityMods = addedModifiers.filter(m => 
      ['nonReentrant', 'whenNotPaused'].some(sm => m.includes(sm))
    )
    if (securityMods.length > 0) {
      result.securityNote = `Added security protection: ${securityMods.join(', ')}`
    }
    
    const accessMods = addedModifiers.filter(m =>
      ['onlyOwner', 'onlyRole', 'onlyAdmin'].some(am => m.includes(am))
    )
    if (accessMods.length > 0) {
      result.breakingNote = `Access restricted: now requires ${accessMods.join(' or ')}`
    }
  }
  
  if (removedModifiers.length > 0) {
    result.context = result.context
      ? `${result.context}, removed restrictions: ${removedModifiers.join(', ')}`
      : `removed restrictions: ${removedModifiers.join(', ')}`
  }
  
  // Check state mutability changes
  if (oldFunc.stateMutability !== newFunc.stateMutability) {
    if (newFunc.stateMutability === 'payable') {
      result.context = 'now accepts ETH payments'
    } else if (newFunc.stateMutability === 'view' || newFunc.stateMutability === 'pure') {
      result.context = 'converted to read-only function'
    }
  }
  
  return result
}

/**
 * Infer semantic description for event addition
 */
export function inferEventAddition(event: EventInfo): SemanticDescription {
  const result: SemanticDescription = {
    shortDescription: `Added event \`${event.name}\``,
  }
  
  // Check event purpose
  const purposePatterns = {
    transfer: 'for tracking transfers',
    swap: 'for tracking swaps',
    bridge: 'for tracking bridge operations',
    deposit: 'for tracking deposits',
    withdraw: 'for tracking withdrawals',
    update: 'for tracking updates',
    approval: 'for tracking approvals',
    stake: 'for tracking staking',
    claim: 'for tracking claims',
  }
  
  for (const [pattern, purpose] of Object.entries(purposePatterns)) {
    if (event.name.toLowerCase().includes(pattern)) {
      result.context = purpose
      break
    }
  }
  
  // Use NatSpec if available
  if (event.documentation) {
    const cleanDoc = event.documentation.replace(/\n/g, ' ').trim()
    if (cleanDoc.length > 0 && cleanDoc.length < 100) {
      result.shortDescription = `Added event \`${event.name}\`: ${cleanDoc}`
      return result
    }
  }
  
  return result
}

/**
 * Infer semantic description for storage variable change
 */
export function inferStorageChange(vars: StateVarInfo[]): SemanticDescription {
  const result: SemanticDescription = {
    shortDescription: 'Storage layout modified',
  }
  
  result.breakingNote = 'Breaking for upgradeable contracts: requires redeployment or storage migration'
  
  if (vars.length > 0) {
    const varNames = vars.map(v => `\`${v.name}\``).join(', ')
    result.context = `affected variables: ${varNames}`
  }
  
  return result
}

/**
 * Parse commit message for semantic context
 */
export function parseCommitMessage(message: string): {
  type: string
  scope?: string
  description: string
  body?: string
} {
  // Support conventional commits format
  const conventionalRegex = /^(\w+)(?:\(([^)]+)\))?: (.+)$/
  const match = message.match(conventionalRegex)
  
  if (match) {
    const [, type, scope, description] = match
    const lines = message.split('\n')
    const body = lines.length > 2 ? lines.slice(2).join('\n').trim() : undefined
    
    return { type, scope, description, body }
  }
  
  // Fallback to first line
  const firstLine = message.split('\n')[0]
  return {
    type: 'unknown',
    description: firstLine,
  }
}

/**
 * Infer breaking change severity
 */
export function isBreakingChange(
  oldFunc: FunctionInfo | null,
  newFunc: FunctionInfo | null
): boolean {
  // Function removed
  if (oldFunc && !newFunc) return true
  
  // Function added (not breaking)
  if (!oldFunc && newFunc) return false
  
  // Function modified
  if (oldFunc && newFunc) {
    // Signature changed
    if (oldFunc.params.length !== newFunc.params.length) return true
    if (oldFunc.returns.length !== newFunc.returns.length) return true
    
    // Visibility changed to more restrictive
    if (oldFunc.visibility === 'public' && newFunc.visibility === 'external') return true
    if ((oldFunc.visibility === 'public' || oldFunc.visibility === 'external') && 
        (newFunc.visibility === 'internal' || newFunc.visibility === 'private')) return true
    
    // Access control added
    const addedAccessControl = newFunc.modifiers.some(m =>
      ['onlyOwner', 'onlyRole', 'onlyAdmin'].some(am => m.includes(am))
    ) && !oldFunc.modifiers.some(m =>
      ['onlyOwner', 'onlyRole', 'onlyAdmin'].some(am => m.includes(am))
    )
    if (addedAccessControl) return true
  }
  
  return false
}
