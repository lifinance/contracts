/**
 * AST-based Solidity Contract Analyzer
 * 
 * Uses Solidity compiler AST for precise analysis instead of regex
 */

import { execSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'

export interface FunctionInfo {
  name: string
  visibility: 'public' | 'external' | 'internal' | 'private'
  stateMutability?: 'pure' | 'view' | 'payable' | 'nonpayable'
  params: Array<{ name: string; type: string }>
  returns: Array<{ name: string; type: string }>
  modifiers: string[]
  documentation?: string
}

export interface EventInfo {
  name: string
  params: Array<{ name: string; type: string; indexed: boolean }>
  documentation?: string
}

export interface ErrorInfo {
  name: string
  params: Array<{ name: string; type: string }>
}

export interface StateVarInfo {
  name: string
  type: string
  visibility: 'public' | 'internal' | 'private'
  constant: boolean
  documentation?: string
}

export interface ContractAST {
  name: string
  functions: FunctionInfo[]
  events: EventInfo[]
  errors: ErrorInfo[]
  stateVars: StateVarInfo[]
  modifiers: string[]
}

/**
 * Parse Solidity contract using AST
 */
export function parseContractAST(content: string, filename: string): ContractAST | null {
  try {
    // Create temporary file for compilation
    const tempFile = join('/tmp', `temp_${Date.now()}.sol`)
    writeFileSync(tempFile, content)
    
    try {
      // Compile with AST output
      const astJson = execSync(
        `solc --ast-compact-json ${tempFile} 2>/dev/null || echo '{}'`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      )
      
      // Clean up temp file
      if (existsSync(tempFile)) {
        unlinkSync(tempFile)
      }
      
      if (!astJson || astJson.trim() === '{}') {
        // Fallback to basic parsing if AST fails
        return null
      }
      
      const ast = JSON.parse(astJson)
      return extractContractInfo(ast, filename)
    } catch (compileError) {
      console.error(`AST compilation failed for ${filename}:`, compileError)
      if (existsSync(tempFile)) {
        unlinkSync(tempFile)
      }
      return null
    }
  } catch (error) {
    console.error(`Error parsing AST for ${filename}:`, error)
    return null
  }
}

/**
 * Extract contract information from AST
 */
function extractContractInfo(ast: any, filename: string): ContractAST {
  const contractName = filename.split('/').pop()?.replace('.sol', '') || 'Unknown'
  
  const result: ContractAST = {
    name: contractName,
    functions: [],
    events: [],
    errors: [],
    stateVars: [],
    modifiers: [],
  }
  
  // Navigate AST to find contract nodes
  traverseAST(ast, (node: any) => {
    if (node.nodeType === 'ContractDefinition') {
      result.name = node.name || contractName
      
      // Process contract members
      if (node.nodes) {
        for (const member of node.nodes) {
          switch (member.nodeType) {
            case 'FunctionDefinition':
              const funcInfo = extractFunctionInfo(member)
              if (funcInfo) result.functions.push(funcInfo)
              break
              
            case 'EventDefinition':
              const eventInfo = extractEventInfo(member)
              if (eventInfo) result.events.push(eventInfo)
              break
              
            case 'ErrorDefinition':
              const errorInfo = extractErrorInfo(member)
              if (errorInfo) result.errors.push(errorInfo)
              break
              
            case 'VariableDeclaration':
              const varInfo = extractStateVarInfo(member)
              if (varInfo) result.stateVars.push(varInfo)
              break
              
            case 'ModifierDefinition':
              if (member.name) result.modifiers.push(member.name)
              break
          }
        }
      }
    }
  })
  
  return result
}

/**
 * Extract function information from AST node
 */
function extractFunctionInfo(node: any): FunctionInfo | null {
  if (!node.name || node.name === '') return null
  
  // Skip internal/private functions
  if (node.visibility === 'internal' || node.visibility === 'private') {
    return null
  }
  
  const params = node.parameters?.parameters?.map((p: any) => ({
    name: p.name || '',
    type: getTypeName(p.typeName),
  })) || []
  
  const returns = node.returnParameters?.parameters?.map((p: any) => ({
    name: p.name || '',
    type: getTypeName(p.typeName),
  })) || []
  
  const modifiers = node.modifiers?.map((m: any) => m.modifierName?.name || '').filter(Boolean) || []
  
  return {
    name: node.name,
    visibility: node.visibility || 'public',
    stateMutability: node.stateMutability,
    params,
    returns,
    modifiers,
    documentation: node.documentation?.text,
  }
}

/**
 * Extract event information from AST node
 */
function extractEventInfo(node: any): EventInfo | null {
  if (!node.name) return null
  
  const params = node.parameters?.parameters?.map((p: any) => ({
    name: p.name || '',
    type: getTypeName(p.typeName),
    indexed: p.indexed || false,
  })) || []
  
  return {
    name: node.name,
    params,
    documentation: node.documentation?.text,
  }
}

/**
 * Extract error information from AST node
 */
function extractErrorInfo(node: any): ErrorInfo | null {
  if (!node.name) return null
  
  const params = node.parameters?.parameters?.map((p: any) => ({
    name: p.name || '',
    type: getTypeName(p.typeName),
  })) || []
  
  return {
    name: node.name,
    params,
  }
}

/**
 * Extract state variable information from AST node
 */
function extractStateVarInfo(node: any): StateVarInfo | null {
  if (!node.name || !node.stateVariable) return null
  
  return {
    name: node.name,
    type: getTypeName(node.typeName),
    visibility: node.visibility || 'internal',
    constant: node.constant || false,
    documentation: node.documentation?.text,
  }
}

/**
 * Get type name from AST type node
 */
function getTypeName(typeNode: any): string {
  if (!typeNode) return 'unknown'
  
  switch (typeNode.nodeType) {
    case 'ElementaryTypeName':
      return typeNode.name || 'unknown'
      
    case 'UserDefinedTypeName':
      return typeNode.pathNode?.name || typeNode.name || 'unknown'
      
    case 'ArrayTypeName':
      const baseType = getTypeName(typeNode.baseType)
      return typeNode.length ? `${baseType}[${typeNode.length}]` : `${baseType}[]`
      
    case 'Mapping':
      const keyType = getTypeName(typeNode.keyType)
      const valueType = getTypeName(typeNode.valueType)
      return `mapping(${keyType} => ${valueType})`
      
    default:
      return typeNode.name || 'unknown'
  }
}

/**
 * Traverse AST recursively
 */
function traverseAST(node: any, callback: (node: any) => void) {
  if (!node || typeof node !== 'object') return
  
  callback(node)
  
  // Traverse children
  if (Array.isArray(node)) {
    node.forEach(child => traverseAST(child, callback))
  } else {
    Object.values(node).forEach(value => {
      if (typeof value === 'object') {
        traverseAST(value, callback)
      }
    })
  }
}

/**
 * Format function signature for display
 */
export function formatFunctionSignature(func: FunctionInfo): string {
  const params = func.params.map(p => p.type).join(', ')
  const returns = func.returns.length > 0
    ? ` returns (${func.returns.map(r => r.type).join(', ')})`
    : ''
  
  return `${func.name}(${params})${returns}`
}

/**
 * Format event signature for display
 */
export function formatEventSignature(event: EventInfo): string {
  const params = event.params.map(p => 
    `${p.indexed ? 'indexed ' : ''}${p.type} ${p.name}`
  ).join(', ')
  
  return `${event.name}(${params})`
}
