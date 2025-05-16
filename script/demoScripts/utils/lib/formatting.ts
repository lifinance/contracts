/**
 * Truncate calldata for display purposes
 */
export function truncateCalldata(calldata: string, length: number = 10): string {
  if (!calldata || calldata.length <= length * 2) return calldata
  
  const prefix = calldata.substring(0, length * 2)
  return `${prefix}...`
}