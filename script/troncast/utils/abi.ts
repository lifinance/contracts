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

/** An ABI function entry, in the shape a TronWeb contract wrapper carries it. */
export interface IAbiFunctionEntry {
  type?: string
  name?: string
  inputs?: { type: string; name?: string }[]
}

/**
 * The slice of a TronWeb contract wrapper the lookup reads.
 *
 * `methodInstances[name]` is the very object `contract[name](...)` is bound to,
 * so its `functionSelector` is the selector the broadcast will use — TronWeb
 * formats it through ethers, which canonicalises the ABI's own type spellings.
 */
export interface ITronContractMethods {
  abi?: readonly IAbiFunctionEntry[]
  methodInstances?: Record<string, { functionSelector?: string } | undefined>
}

export interface IBroadcastCall {
  /** Canonical selector, taken from the broadcast's own method instance. */
  functionSelector: string
  /** Input types of the same ABI entry, in order. */
  inputTypes: string[]
}

const isFunctionEntry = (entry: IAbiFunctionEntry): boolean =>
  // Tron nodes return `"type": "Function"` for some contracts, and omit the
  // field for others.
  (entry.type ?? 'function').toLowerCase() === 'function'

const formatEntry = (name: string, entry: IAbiFunctionEntry): string =>
  `${name}(${(entry.inputs ?? []).map((input) => input.type).join(',')})`

/**
 * Resolves the call the broadcast will make, so a pre-flight prices that call.
 *
 * The signature an operator types is not a selector: `parseFunctionSignature`
 * returns the spelling as given, and a non-canonical but perfectly valid one
 * (`uint` for `uint256`, `byte` for `bytes1`, a struct name for a tuple) hashes
 * to a selector no contract has. Read off the ABI entry instead of
 * canonicalising the string, so there is one source of truth rather than a
 * conversion table to drift from the ABI encoder.
 *
 * @param contract - The TronWeb contract wrapper the broadcast goes through.
 * @param name - Function name, as parsed from the typed signature.
 * @param typedInputTypes - Input types as typed; used only to pick an overload.
 * @returns The selector the broadcast will use and that entry's input types.
 * @throws When the ABI in use has no such function, when it takes a different
 * number of arguments, or when the name is overloaded and the broadcast — which
 * resolves a bare name to one entry — would not reach the one asked for.
 */
export function resolveBroadcastCall(
  contract: ITronContractMethods,
  name: string,
  typedInputTypes: readonly string[]
): IBroadcastCall {
  const declared = (contract.abi ?? []).filter(
    (entry) => isFunctionEntry(entry) && entry.name === name
  )
  const bound = contract.methodInstances?.[name]?.functionSelector

  if (declared.length === 0 || bound === undefined || bound === '')
    throw new Error(
      `The ABI in use declares no function named "${name}", so there is nothing ` +
        `to estimate or to send. Pass the call as --calldata when the contract ` +
        `does not publish an ABI carrying it.`
    )

  // TronWeb binds `contract[name]` to the last ABI entry of that name, so that
  // is the entry the broadcast uses whatever spelling the operator typed.
  const boundEntry = declared[declared.length - 1] as IAbiFunctionEntry

  const sameArity = declared.filter(
    (entry) => (entry.inputs ?? []).length === typedInputTypes.length
  )

  if (sameArity.length === 0)
    throw new Error(
      `"${name}" takes a different number of arguments in the ABI in use ` +
        `(${declared
          .map((entry) => formatEntry(name, entry))
          .join(', ')}) than the ${typedInputTypes.length} given.`
    )

  const asTyped = sameArity.filter((entry) =>
    (entry.inputs ?? []).every(
      (input, index) => input.type === typedInputTypes[index]
    )
  )
  const chosen =
    sameArity.length === 1
      ? sameArity[0]
      : asTyped.length === 1
      ? asTyped[0]
      : undefined

  if (chosen === undefined || chosen !== boundEntry)
    throw new Error(
      `Refusing to guess which "${name}" to send. The ABI in use declares ` +
        `${declared
          .map((entry) => formatEntry(name, entry))
          .join(', ')}, and the broadcast resolves the bare name to ` +
        `${formatEntry(
          name,
          boundEntry
        )}. Pass the call as --calldata to name ` +
        `the overload exactly.`
    )

  return {
    functionSelector: bound,
    inputTypes: (boundEntry.inputs ?? []).map((input) => input.type),
  }
}
