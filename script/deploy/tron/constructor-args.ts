/**
 * Constructor arguments for a Tron deployment record.
 *
 * Import this wherever a deployment is recorded: the recorded arguments are what
 * a verifier rebuilds creation code from, so a record claiming a contract took
 * none when it took two describes a deployment that never happened.
 */

/** What a record holds when a contract genuinely takes no arguments. */
const NO_ARGS = '0x'

/** Both spellings appear in existing records; `''` predates the sentinel. */
const isEmptyRecord = (recorded: string): boolean =>
  recorded.trim() === '' || /^0x$/i.test(recorded.trim())

const isHex = (value: string): boolean => {
  const normalized = value.trim()
  // Whole bytes only: '0x0' is a nibble, and half a byte of a record is not a
  // value the constructor could have received.
  return /^0x[0-9a-f]*$/iu.test(normalized) && (normalized.length - 2) % 2 === 0
}

interface IAbiParameter {
  type: string
  components?: readonly unknown[]
}

const asParameter = (input: unknown, contractName: string): IAbiParameter => {
  if (typeof input !== 'object' || input === null)
    throw new Error(
      `${contractName}: a constructor input is not an object, so its type cannot be read`
    )
  const { type, components } = input as { type?: unknown; components?: unknown }
  if (typeof type !== 'string' || type === '')
    throw new Error(
      `${contractName}: a constructor input has no type, so it cannot be encoded`
    )
  return {
    type,
    ...(Array.isArray(components) ? { components } : {}),
  }
}

/**
 * Renders one ABI parameter as its canonical type string.
 *
 * Tuples have to be expanded into `(a,b)` because an encoder given the literal
 * word `tuple` has no idea what it is encoding.
 */
const canonicalType = (input: unknown, contractName: string): string => {
  const { type, components } = asParameter(input, contractName)
  if (!type.startsWith('tuple')) return type

  if (!components)
    throw new Error(
      `${contractName}: a tuple constructor input has no components, so its type cannot be built`
    )

  const inner = components
    .map((component) => canonicalType(component, contractName))
    .join(',')
  // Anything after `tuple` is array suffixes, e.g. `tuple[2][]`.
  return `(${inner})${type.slice('tuple'.length)}`
}

/**
 * Reads a constructor's parameter types out of a contract's ABI.
 *
 * Throws rather than returning an empty list when the ABI cannot be read: an
 * empty list means "this contract takes no arguments", and letting a malformed
 * artifact say that is how a record ends up claiming a deployment had none.
 *
 * @param abi - The `abi` array from a Forge artifact.
 * @param contractName - Named in every message; the caller always knows it.
 * @returns Canonical type strings in declaration order, empty when the contract
 * declares no constructor.
 * @throws When the ABI, a constructor input, or a tuple components list cannot be read.
 */
export const constructorInputTypes = (
  abi: unknown,
  contractName = 'contract'
): string[] => {
  if (!Array.isArray(abi))
    throw new Error(
      `${contractName}: the artifact holds no readable ABI, so its constructor cannot be read`
    )

  const constructor = abi.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'constructor'
  )
  if (!constructor) return []

  const { inputs } = constructor as { inputs?: unknown }
  if (inputs === undefined) return []
  if (!Array.isArray(inputs))
    throw new Error(
      `${contractName}: the constructor's inputs are not a list, so its types cannot be read`
    )

  return inputs.map((input) => canonicalType(input, contractName))
}

/**
 * Checks a record's constructor arguments against what the contract can take.
 *
 * Both current call sites feed this the string {@link encodeConstructorArgs}
 * just produced from the same `types`, which already guarantees hex output and
 * matching arity — so of the checks below, only the word-count one can still
 * fire there, and only if the underlying ABI encoder itself returns fewer
 * words than the types call for. The empty-vs-non-empty checks earn their keep
 * against a `recorded` that did NOT come from a fresh encode, e.g. an existing
 * deployment record being audited independently.
 *
 * @param contractName - Contract the record is for.
 * @param recorded - The string about to be written to the record.
 * @param types - Declared constructor types, from {@link constructorInputTypes}.
 * @throws When the record and the ABI disagree about whether there are
 * arguments, in either direction.
 */
export const assertRecordedArgsMatchAbi = (
  contractName: string,
  recorded: string,
  types: readonly string[]
): void => {
  const empty = isEmptyRecord(recorded)

  if (types.length > 0 && empty)
    throw new Error(
      `${contractName} takes ${
        types.length
      } constructor arguments (${types.join(
        ', '
      )}) but the record says it has none. A verifier rebuilding creation code from this record would compute a different deployment.`
    )

  if (types.length > 0 && !isHex(recorded))
    throw new Error(
      `${contractName}'s recorded constructor arguments are not hex, so they are not what the constructor received.`
    )

  // Each static parameter occupies one 32-byte word, and a dynamic one occupies
  // at least an offset word, so anything shorter is truncated.
  const words = (recorded.trim().replace(/^0x/iu, '').length / 64) | 0
  if (types.length > 0 && words < types.length)
    throw new Error(
      `${contractName} takes ${types.length} constructor arguments but the record holds only ${words} words of them.`
    )

  if (types.length === 0 && !empty)
    throw new Error(
      `${contractName} takes no constructor arguments, but the record carries ${
        recorded.trim().length
      } characters of them. Either the record is for a different contract or the arguments are wrong.`
    )
}

/** Encodes ABI parameters. Tron's encoder accepts base58 addresses; viem's does not. */
export type AbiParamEncoder = (
  types: string[],
  values: readonly unknown[]
) => string

/**
 * Encodes constructor arguments using the contract's declared types.
 *
 * Every failure throws. Substituting a best-effort encoding writes bytes that
 * are not what the constructor received, and nothing downstream can tell the
 * difference — a failed deploy is recoverable, a wrong record is not.
 *
 * @param encoder - ABI encoder to call, e.g. TronWeb's.
 * @param args - Values passed to the constructor, in declaration order.
 * @param types - Declared types, from {@link constructorInputTypes}.
 * @param contractName - Named in every message.
 * @returns Hex-encoded arguments, or `0x` when the contract takes none.
 */
export const encodeConstructorArgs = (
  encoder: AbiParamEncoder,
  args: readonly unknown[],
  types: readonly string[],
  contractName: string
): string => {
  if (args.length !== types.length)
    throw new Error(
      `${contractName} expects ${types.length} constructor arguments, got ${args.length}`
    )

  if (types.length === 0) return NO_ARGS

  let encoded: string
  try {
    encoded = encoder([...types], args)
  } catch (error) {
    throw new Error(
      `${contractName}: encoding constructor arguments failed (${
        error instanceof Error ? error.message : String(error)
      })`
    )
  }

  if (typeof encoded !== 'string' || !isHex(encoded))
    throw new Error(
      `${contractName}: the ABI encoder did not return hex, so there is nothing safe to record`
    )

  return encoded
}
