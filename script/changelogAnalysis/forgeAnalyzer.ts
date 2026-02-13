/**
 * Forge-based Contract Analyzer
 * 
 * Uses Foundry tools for storage layout and ABI analysis
 */

import { execSync } from 'child_process'

export interface StorageLayoutSlot {
  label: string
  offset: number
  slot: string
  type: string
}

export interface ForgeInspectionResult {
  storageLayout: StorageLayoutSlot[]
  abi: any[]
  methods: Record<string, string>
}

/**
 * Inspect contract using Forge
 */
export function inspectContractWithForge(
  contractPath: string,
  contractName: string
): ForgeInspectionResult | null {
  try {
    const result: ForgeInspectionResult = {
      storageLayout: [],
      abi: [],
      methods: {},
    }
    
    // Get storage layout
    try {
      const storageOutput = execSync(
        `forge inspect ${contractPath}:${contractName} storageLayout 2>/dev/null || echo '{}'`,
        { encoding: 'utf-8', cwd: process.cwd() }
      )
      
      if (storageOutput && storageOutput.trim() !== '{}') {
        const storage = JSON.parse(storageOutput)
        result.storageLayout = storage.storage || []
      }
    } catch (error) {
      // Storage layout not critical, continue
    }
    
    // Get ABI
    try {
      const abiOutput = execSync(
        `forge inspect ${contractPath}:${contractName} abi 2>/dev/null || echo '[]'`,
        { encoding: 'utf-8', cwd: process.cwd() }
      )
      
      if (abiOutput && abiOutput.trim() !== '[]') {
        result.abi = JSON.parse(abiOutput)
      }
    } catch (error) {
      // ABI not critical, continue
    }
    
    // Get method identifiers
    try {
      const methodsOutput = execSync(
        `forge inspect ${contractPath}:${contractName} methods 2>/dev/null || echo '{}'`,
        { encoding: 'utf-8', cwd: process.cwd() }
      )
      
      if (methodsOutput && methodsOutput.trim() !== '{}') {
        result.methods = JSON.parse(methodsOutput)
      }
    } catch (error) {
      // Methods not critical, continue
    }
    
    return result
  } catch (error) {
    console.error(`Forge inspection failed for ${contractPath}:${contractName}:`, error)
    return null
  }
}

/**
 * Compare storage layouts to detect breaking changes
 */
export function compareStorageLayouts(
  oldLayout: StorageLayoutSlot[],
  newLayout: StorageLayoutSlot[]
): {
  isBreaking: boolean
  changes: string[]
} {
  const changes: string[] = []
  let isBreaking = false
  
  // Check for removed variables
  for (const oldSlot of oldLayout) {
    const found = newLayout.find(s => s.label === oldSlot.label)
    if (!found) {
      changes.push(`Removed storage variable \`${oldSlot.label}\``)
      isBreaking = true
    }
  }
  
  // Check for slot changes (reordering or type changes)
  for (const newSlot of newLayout) {
    const oldSlot = oldLayout.find(s => s.label === newSlot.label)
    if (oldSlot) {
      if (oldSlot.slot !== newSlot.slot) {
        changes.push(`Storage variable \`${newSlot.label}\` moved to different slot`)
        isBreaking = true
      }
      if (oldSlot.type !== newSlot.type) {
        changes.push(`Storage variable \`${newSlot.label}\` type changed`)
        isBreaking = true
      }
    }
  }
  
  // Check for added variables (not breaking if appended)
  const addedVars = newLayout.filter(s => !oldLayout.find(old => old.label === s.label))
  if (addedVars.length > 0) {
    // Check if they're appended (safe) or inserted (breaking)
    const maxOldSlot = oldLayout.length > 0 
      ? Math.max(...oldLayout.map(s => parseInt(s.slot)))
      : -1
    
    const insertedVars = addedVars.filter(v => parseInt(v.slot) <= maxOldSlot)
    
    if (insertedVars.length > 0) {
      changes.push(`Inserted storage variable(s): ${insertedVars.map(v => `\`${v.label}\``).join(', ')}`)
      isBreaking = true
    } else {
      changes.push(`Appended storage variable(s): ${addedVars.map(v => `\`${v.label}\``).join(', ')} (safe)`)
    }
  }
  
  return { isBreaking, changes }
}

/**
 * Compare ABIs to detect interface changes
 */
export function compareABIs(oldAbi: any[], newAbi: any[]): {
  addedFunctions: string[]
  removedFunctions: string[]
  changedFunctions: string[]
} {
  const result = {
    addedFunctions: [] as string[],
    removedFunctions: [] as string[],
    changedFunctions: [] as string[],
  }
  
  const oldFunctions = oldAbi.filter(item => item.type === 'function')
  const newFunctions = newAbi.filter(item => item.type === 'function')
  
  // Find added functions
  for (const newFunc of newFunctions) {
    const found = oldFunctions.find(f => f.name === newFunc.name)
    if (!found) {
      result.addedFunctions.push(newFunc.name)
    } else {
      // Check if signature changed
      const oldSig = JSON.stringify(found.inputs)
      const newSig = JSON.stringify(newFunc.inputs)
      if (oldSig !== newSig) {
        result.changedFunctions.push(newFunc.name)
      }
    }
  }
  
  // Find removed functions
  for (const oldFunc of oldFunctions) {
    const found = newFunctions.find(f => f.name === oldFunc.name)
    if (!found) {
      result.removedFunctions.push(oldFunc.name)
    }
  }
  
  return result
}

/**
 * Estimate gas impact from changes (simplified heuristic)
 */
export function estimateGasImpact(
  oldLayout: StorageLayoutSlot[],
  newLayout: StorageLayoutSlot[]
): {
  impact: 'none' | 'reduced' | 'increased' | 'significant'
  description?: string
} {
  // More storage slots = more gas
  const storageDiff = newLayout.length - oldLayout.length
  
  if (storageDiff > 3) {
    return {
      impact: 'increased',
      description: `Added ${storageDiff} storage slots; operations will consume more gas`,
    }
  }
  
  if (storageDiff < -2) {
    return {
      impact: 'reduced',
      description: `Removed ${Math.abs(storageDiff)} storage slots; gas optimization achieved`,
    }
  }
  
  return { impact: 'none' }
}
