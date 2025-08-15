export function encodeFunctionCall(
  tronWeb: any,
  _functionName: string,
  types: string[],
  values: any[]
): string {
  try {
    // Use TronWeb's ABI encoder
    const encoded = tronWeb.utils.abi.encodeParams(types, values)
    return encoded
  } catch (error: any) {
    throw new Error(`Failed to encode parameters: ${error.message}`)
  }
}

export function decodeFunctionResult(
  tronWeb: any,
  types: string[],
  data: string
): any[] {
  try {
    if (!data || data === '0x') return []

    // Use TronWeb's ABI decoder
    const decoded = tronWeb.utils.abi.decodeParams(types, data)
    return decoded
  } catch (error: any) {
    throw new Error(`Failed to decode result: ${error.message}`)
  }
}

export function formatOutput(type: string, value: any): string {
  if (type === 'address')
    // Convert to base58 if needed
    return value
  else if (type.startsWith('uint') || type.startsWith('int'))
    return value.toString()
  else if (type === 'bool') return value ? 'true' : 'false'
  else if (type.startsWith('bytes')) return value
  else if (type === 'string') return value
  else if (Array.isArray(value)) return JSON.stringify(value)

  return String(value)
}
