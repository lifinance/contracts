import * as fs from 'fs'

import { consola } from 'consola'
import { type Address, type Hex } from 'viem'

import type { IProposeToSafeOptions } from '../../common/types'

import { validateCallPairs } from './timelock-abi'

/**
 * Normalizes and validates the to/calldata propose options into parallel call
 * arrays (multiple --to/--calldata pairs are allowed). Pure apart from reading
 * `calldataFile`. Lives in its own module (not propose-to-safe.ts, whose import
 * triggers the citty CLI via runMain) so it is unit-testable.
 * @param options - The to/calldata/calldataFile/timelock subset of the propose options
 * @returns Parallel `targets`/`calldatas` arrays, one entry per inner call
 * @throws On length mismatch, multi-call without timelock, calldataFile combined
 *         with multiple pairs, invalid addresses, or malformed calldata hex
 */
export function normalizeProposeCalls(
  options: Pick<IProposeToSafeOptions, 'to' | 'calldataFile' | 'timelock'> &
    Partial<Pick<IProposeToSafeOptions, 'calldata'>>
): { targets: Address[]; calldatas: Hex[] } {
  const targets = (
    Array.isArray(options.to) ? options.to : [options.to]
  ) as Address[]

  let calldatas: Hex[]
  if (options.calldataFile) {
    // The CLI defaults --calldata to '' when omitted, so "provided" means a
    // non-empty value (mirrors the else-if below) — empty string is not a clash
    if (options.calldata && options.calldata.length > 0)
      throw new Error('Provide either --calldata or --calldataFile, not both')
    if (targets.length > 1)
      throw new Error(
        '--calldataFile cannot be combined with multiple --to/--calldata pairs'
      )
    if (!fs.existsSync(options.calldataFile))
      throw new Error(`Calldata file not found: ${options.calldataFile}`)
    calldatas = [fs.readFileSync(options.calldataFile, 'utf8').trim() as Hex]
    consola.info(`Loaded calldata from file: ${options.calldataFile}`)
  } else if (options.calldata && options.calldata.length > 0) {
    calldatas = (
      Array.isArray(options.calldata) ? options.calldata : [options.calldata]
    ) as Hex[]
  } else {
    throw new Error('Either --calldata or --calldataFile must be provided')
  }

  if (targets.length !== calldatas.length)
    throw new Error(
      `Number of --to addresses (${targets.length}) must match number of --calldata values (${calldatas.length})`
    )

  // Multiple calls are only combinable via the timelock's scheduleBatch
  if (targets.length > 1 && !options.timelock)
    throw new Error(
      'Multiple --to/--calldata pairs require --timelock (combined into a single scheduleBatch proposal)'
    )

  // Reject malformed inputs here, before signing: viem would silently zero-pad
  // non-hex calldata into valid-looking bytes that only fail at execution time
  validateCallPairs(targets, calldatas, '--to', '--calldata')
  // An empty payload in a multi-call batch is almost certainly an upstream
  // bug (e.g. comma-splitting); plain 0x stays allowed for single calls
  // (legitimate for e.g. nonce-gap filler self-calls)
  for (const [i, calldata] of calldatas.entries())
    if (calldatas.length > 1 && calldata === '0x')
      throw new Error(
        `--calldata at index ${i} is empty (0x); empty payloads are not allowed in multi-call proposals`
      )

  return { targets, calldatas }
}
