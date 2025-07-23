// SPDX-License-Identifier: LGPL-3.0-only

import type { IDecodedTransaction } from './safe-decode-utils'

export interface ITimelockDetails {
  target: string
  value: string
  data: string
  predecessor: string
  salt: string
  delay: string
  nestedCall?: IDecodedTransaction
}

/**
 * Extracts timelock details from a decoded transaction
 * @param decoded - The decoded transaction
 * @returns Timelock details or null if not a schedule function
 */
export function extractTimelockDetails(
  decoded: IDecodedTransaction
): ITimelockDetails | null {
  if (
    decoded.functionName !== 'schedule' ||
    !decoded.args ||
    decoded.args.length < 6
  ) 
    return null
  

  const [target, value, data, predecessor, salt, delay] = decoded.args

  return {
    target,
    value,
    data,
    predecessor,
    salt,
    delay,
    nestedCall: decoded.nestedCall,
  }
}

/**
 * Prepares nested call data for display
 * @param nested - The nested decoded transaction
 * @param chainId - Chain ID for additional decoding
 * @returns Prepared display data
 */
export async function prepareNestedCallDisplay(
  nested: IDecodedTransaction,
  _chainId: number
): Promise<{
  functionName: string
  contractName?: string
  decodedVia: string
  diamondCutData?: any
  decodedData?: any
  args?: any[]
  error?: string
}> {
  const result: any = {
    functionName: nested.functionName || nested.selector,
    contractName: nested.contractName,
    decodedVia: nested.decodedVia,
  }

  // Handle diamondCut specially
  if (nested.functionName === 'diamondCut' && nested.args) 
    try {
      // Note: decodeDiamondCut modifies console output directly
      // For testing, we'd need to refactor that too
      result.diamondCutData = {
        functionName: 'diamondCut',
        args: nested.args,
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
   else if (
    nested.functionName === 'diamondCut' &&
    !nested.args &&
    nested.rawData
  ) 
    // Try to decode if we have raw data but no args
    try {
      // In a real implementation, this would decode the raw data
      // For now, we'll just return an error
      result.error = 'Failed to decode diamondCut: Unknown signature'
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
   else if (
    nested.functionName === 'diamondCut' &&
    nested.decodedVia === 'unknown'
  ) 
    result.error = 'No ABI found for diamondCut function'
   else if (nested.args) 
    result.args = nested.args
  

  return result
}
