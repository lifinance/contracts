/**
 * Violation: Safe decode script doesn't use formatDecodedTxDataForDisplay.
 * 
 * Convention violation: Human-readable decoded Safe/timelock transaction data
 * MUST be produced via formatDecodedTxDataForDisplay(data, context) from
 * safe-decode-utils.ts.
 * 
 * Scripts showing Safe or timelock calldata MUST call this function instead
 * of duplicating decode/format logic.
 * 
 * This file violates by implementing its own decode/format logic.
 */

import { consola } from 'consola'
import { decodeFunctionData, parseAbi, type Hex } from 'viem'

// Violation: Implements custom decode logic instead of using formatDecodedTxDataForDisplay
function decodeSafeTransaction(data: Hex) {
  // Violation: Should use formatDecodedTxDataForDisplay from safe-decode-utils.ts
  const abi = parseAbi(['function diamondCut(...)'])
  
  try {
    const decoded = decodeFunctionData({
      abi,
      data,
    })
    
    // Violation: Custom formatting instead of using formatDecodedTxDataForDisplay
    consola.info('Decoded transaction:')
    consola.info(`Function: ${decoded.functionName}`)
    consola.info(`Args: ${JSON.stringify(decoded.args)}`)
    
    return decoded
  } catch (error) {
    // Violation: Custom error handling instead of using shared formatter
    consola.error('Failed to decode transaction')
    throw error
  }
}

// Violation: Implements custom diamond cut formatting
function formatDiamondCut(decoded: unknown) {
  // Violation: Should use formatDiamondCutSummary from safe-decode-utils.ts
  consola.info('Diamond Cut Summary:')
  // Custom formatting logic...
}

export function processSafeTransaction(data: Hex, chainId: number, network: string) {
  // Violation: Should call formatDecodedTxDataForDisplay(data, { chainId, network })
  const decoded = decodeSafeTransaction(data)
  formatDiamondCut(decoded)
}
