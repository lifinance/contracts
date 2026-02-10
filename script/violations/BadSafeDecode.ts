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
 * Pass { chainId: number, network: string } context.
 * Decode and formatters live in safe-decode-utils.ts: decodeTransactionData,
 * display helpers (getTargetName, getTargetSuffix), formatters
 * (formatDiamondCutSummary, formatTimelockScheduleBatch, etc.).
 * 
 * This file violates by implementing its own decode/format logic.
 */

import { consola } from 'consola'
import { decodeFunctionData, parseAbi, type Hex } from 'viem'
// Violation: Should import formatDecodedTxDataForDisplay from '../deploy/safe/safe-decode-utils'

// Violation: Implements custom decode logic instead of using formatDecodedTxDataForDisplay
function decodeSafeTransaction(data: Hex) {
  // Violation: Should use formatDecodedTxDataForDisplay from safe-decode-utils.ts instead
  const abi = parseAbi(['function diamondCut((address,uint8,bytes4[])[],address,bytes)'])
  
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
// Should use formatDiamondCutSummary from safe-decode-utils.ts instead
function formatDiamondCut(decoded: unknown) {
  consola.info('Diamond Cut Summary:')
  // Violation: Custom formatting logic instead of using formatDiamondCutSummary
  // Custom formatting logic...
}

// Violation: Implements custom decodeTransactionData logic
// Should use decodeTransactionData from safe-decode-utils.ts instead
function decodeTransactionData(data: Hex) {
  return decodeSafeTransaction(data)
}

export function processSafeTransaction(data: Hex, chainId: number, network: string) {
  // Violation: Should call formatDecodedTxDataForDisplay(data, { chainId, network })
  // Instead of implementing custom decode/format logic
  const decoded = decodeSafeTransaction(data)
  formatDiamondCut(decoded)
  
  // Violation: Should use formatDecodedTxDataForDisplay instead:
  // formatDecodedTxDataForDisplay(data, { chainId, network })
}
