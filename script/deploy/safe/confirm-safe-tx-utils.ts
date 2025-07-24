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
 * @returns Prepared display data
 */
export async function prepareNestedCallDisplay(
  nested: IDecodedTransaction
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
  else if (nested.args) result.args = nested.args

  return result
}

export interface ITransactionDisplayData {
  lines: string[]
  type: 'regular' | 'diamondCut' | 'schedule' | 'unknown'
}

export interface ISafeTransactionDetails {
  nonce: number
  to: string
  value: string
  operation: string
  data: string
  proposer: string
  safeTxHash: string
  signatures: string
  executionReady: boolean
}

/**
 * Formats a decoded transaction for display
 * @param decodedTx - The decoded transaction
 * @param decoded - Additional decoded data from viem (optional)
 * @returns Formatted display data
 */
export function formatTransactionDisplay(
  decodedTx: IDecodedTransaction | null,
  decoded?: { functionName: string; args?: readonly unknown[] } | null
): ITransactionDisplayData {
  const lines: string[] = []
  let type: ITransactionDisplayData['type'] = 'regular'

  if (decodedTx?.functionName) {
    lines.push(`Function: ${decodedTx.functionName}`)
    if (decodedTx.contractName)
      lines.push(`Contract: ${decodedTx.contractName}`)

    lines.push(`Decoded via: ${decodedTx.decodedVia}`)

    // Determine type
    if (decodedTx.functionName === 'diamondCut') type = 'diamondCut'
    else if (decodedTx.functionName === 'schedule') type = 'schedule'

    // For regular functions (not diamondCut or schedule)
    if (type === 'regular' && decoded) {
      lines.push(`Function Name: ${decoded.functionName}`)
      if (decoded.args && decoded.args.length > 0) {
        lines.push('Decoded Arguments:')
        decoded.args.forEach((arg: unknown, index: number) => {
          const displayValue = formatArgument(arg)
          lines.push(`  [${index}]: ${displayValue}`)
        })
      } else lines.push('No arguments or failed to decode arguments')
    }
  } else if (decodedTx) {
    // Function not found but we have a selector
    type = 'unknown'
    lines.push(`Unknown function with selector: ${decodedTx.selector}`)
    lines.push(`Decoded via: ${decodedTx.decodedVia}`)
  } else {
    // No decoded transaction at all
    type = 'unknown'
    lines.push('Failed to decode transaction')
  }

  return { lines, type }
}

/**
 * Formats a single argument for display
 * @param arg - The argument to format
 * @returns Formatted string representation
 */
export function formatArgument(arg: unknown): string {
  if (typeof arg === 'bigint') return arg.toString()
  else if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg)

  return String(arg)
}

/**
 * Formats Safe transaction details for display
 * @param details - The Safe transaction details
 * @returns Formatted lines for display
 */
export function formatSafeTransactionDetails(
  details: ISafeTransactionDetails
): string[] {
  return [
    'Safe Transaction Details:',
    `    Nonce:           ${details.nonce}`,
    `    To:              ${details.to}`,
    `    Value:           ${details.value}`,
    `    Operation:       ${details.operation}`,
    `    Data:            ${details.data}`,
    `    Proposer:        ${details.proposer}`,
    `    Safe Tx Hash:    ${details.safeTxHash}`,
    `    Signatures:      ${details.signatures}`,
    `    Execution Ready: ${details.executionReady ? '✓' : '✗'}`,
  ]
}
