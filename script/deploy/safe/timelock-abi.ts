import {
  encodeFunctionData,
  isAddress,
  isHex,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

/**
 * TimelockController ABIs + selectors shared across Safe scripts.
 *
 * Keep this file dependency-light to avoid circular imports (e.g. safe-decode-utils
 * imports from safe-utils, so safe-utils must not import safe-decode-utils).
 */
export const TIMELOCK_SCHEDULE_BATCH_ABI = parseAbi([
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
])

export const TIMELOCK_SCHEDULE_BATCH_SELECTOR = toFunctionSelector(
  'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)'
)

const ZERO_PREDECESSOR =
  // pre-commit-checker: not a secret — zero bytes32 means "no predecessor"
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

/**
 * Validates parallel target/payload call arrays element-wise. viem's
 * encodeFunctionData silently zero-pads non-hex strings (e.g. a missing 0x
 * prefix) into valid-looking bytes that only fail at execution time, after
 * signing (and any timelock delay) — so reject malformed inputs early. Shared
 * by the CLI input boundary (normalizeProposeCalls) and the encoding boundary
 * (encodeTimelockScheduleBatch), which have different sets of callers.
 * @param targets - Target address per call (parallel to `payloads`)
 * @param payloads - Calldata per call (parallel to `targets`)
 * @param targetLabel - Error-message label for a target entry (e.g. `--to`)
 * @param payloadLabel - Error-message label for a payload entry (e.g. `--calldata`)
 * @throws If a target is not a valid address or a payload is not well-formed hex
 */
export function validateCallPairs(
  targets: readonly string[],
  payloads: readonly string[],
  targetLabel: string,
  payloadLabel: string
): void {
  for (const [i, target] of targets.entries())
    if (!isAddress(target, { strict: false }))
      throw new Error(
        `${targetLabel} at index ${i} is not a valid address: ${target}`
      )
  for (const [i, payload] of payloads.entries())
    if (!isHex(payload, { strict: true }))
      throw new Error(
        `${payloadLabel} at index ${i} is not well-formed hex: ${payload}`
      )
}

/**
 * Encodes a `scheduleBatch` call for the TimelockController from one or more
 * inner calls. Inner calls execute in array order, so callers control ordering
 * (e.g. whitelist removals before additions) via the order of `targets`/`payloads`.
 * @param targets - Target contract address per inner call (parallel to `payloads`)
 * @param payloads - Calldata per inner call (parallel to `targets`)
 * @param salt - Unique salt for the timelock operation id
 * @param minDelay - Timelock delay in seconds
 * @returns The encoded `scheduleBatch` calldata
 * @throws If `targets` is empty, `targets` and `payloads` differ in length, a
 *         target is not a valid address, or a payload is not well-formed hex
 */
export function encodeTimelockScheduleBatch(
  targets: Address[],
  payloads: Hex[],
  salt: Hex,
  minDelay: bigint
): Hex {
  if (targets.length === 0)
    throw new Error('encodeTimelockScheduleBatch requires at least one call')
  if (targets.length !== payloads.length)
    throw new Error(
      `encodeTimelockScheduleBatch: targets (${targets.length}) and payloads (${payloads.length}) must have the same length`
    )

  // Defensive re-validation at the encoding boundary: today's only caller
  // (normalizeProposeCalls) validates already, but this module is the shared
  // encoder for any future caller (e.g. Tron batch proposals)
  validateCallPairs(
    targets,
    payloads,
    'encodeTimelockScheduleBatch: target',
    'encodeTimelockScheduleBatch: payload'
  )

  return encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      targets,
      targets.map(() => 0n), // values
      payloads,
      ZERO_PREDECESSOR,
      salt,
      minDelay,
    ],
  })
}
