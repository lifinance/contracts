import { isHex, type Hex } from 'viem'

/**
 * Normalizes and validates Tron propose `--to`/`--calldata` inputs into parallel
 * call arrays (multiple pairs allowed, combined into one timelock scheduleBatch).
 * Targets are base58 and are validated downstream during base58→EVM conversion,
 * so this only pairs the arrays and validates calldata. Pure; lives in its own
 * module (not propose-to-safe-tron.ts, whose import triggers the citty CLI via
 * runMain) so it is unit-testable.
 * @param to - Base58 target(s): a single string or an array (repeated --to)
 * @param calldata - Hex calldata: a single value or an array (repeated --calldata)
 * @param timelock - Whether the proposal is wrapped in the timelock (required for >1 call)
 * @returns Parallel `targets` (base58) / `calldatas` arrays, one entry per inner call
 * @throws On missing calldata, length mismatch, multi-call without timelock,
 *         malformed calldata hex, or an empty (0x) payload in a multi-call batch
 */
export function normalizeTronProposeCalls(
  to: string | string[] | undefined,
  calldata: Hex | Hex[] | undefined,
  timelock: boolean | undefined
): { targets: string[]; calldatas: Hex[] } {
  // length === 0 covers both an empty array and an empty string
  if (to === undefined || to.length === 0)
    throw new Error('--to must be provided')

  const targets = (Array.isArray(to) ? to : [to]) as string[]

  if (calldata === undefined || calldata.length === 0)
    throw new Error('--calldata must be provided')

  const calldatas = (Array.isArray(calldata) ? calldata : [calldata]) as Hex[]

  if (targets.length !== calldatas.length)
    throw new Error(
      `Number of --to addresses (${targets.length}) must match number of --calldata values (${calldatas.length})`
    )

  // Multiple calls are only combinable via the timelock's scheduleBatch
  if (targets.length > 1 && !timelock)
    throw new Error(
      'Multiple --to/--calldata pairs require --timelock (combined into a single scheduleBatch proposal)'
    )

  // viem's encodeFunctionData silently zero-pads non-hex strings (e.g. a missing
  // 0x prefix) into valid-looking bytes that only fail at execution time, after
  // signing and the timelock delay — so reject malformed calldata here
  for (const [i, cd] of calldatas.entries())
    if (!isHex(cd, { strict: true }))
      throw new Error(`--calldata at index ${i} is not well-formed hex: ${cd}`)

  // An empty payload in a multi-call batch is almost certainly an upstream bug
  // (e.g. comma-splitting); plain 0x stays allowed for single calls
  for (const [i, cd] of calldatas.entries())
    if (calldatas.length > 1 && cd === '0x')
      throw new Error(
        `--calldata at index ${i} is empty (0x); empty payloads are not allowed in multi-call proposals`
      )

  return { targets, calldatas }
}
