import { consola } from 'consola'
import {
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  isHex,
  keccak256,
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

/**
 * `LiFiTimelockController` inherits OpenZeppelin's `TimelockController`, so the
 * singular `schedule` is callable by the Safe even though this repo's tooling
 * only ever emits `scheduleBatch`.
 */
export const TIMELOCK_SCHEDULE_ABI = parseAbi([
  'function schedule(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt, uint256 delay)',
])

export const TIMELOCK_SCHEDULE_SELECTOR = toFunctionSelector(
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)'
)

/**
 * Whether either schedule selector appears in `data` on a byte boundary,
 * anywhere.
 *
 * For a caller that has already ruled out both selectors at offset zero, a hit
 * here means a schedule is reachable through an envelope that caller does not
 * open. Alignment narrows the false-positive class without closing it — an
 * address or other argument can carry the same four bytes at an even offset —
 * and an envelope that splits or transforms the selector is not caught at all,
 * so a hit is grounds to refuse rather than proof of intent.
 * @param data - Calldata to search.
 * @returns Whether a byte-aligned schedule selector is present.
 */
export const carriesTimelockScheduleSelector = (data: Hex): boolean => {
  const body = data.slice(2).toLowerCase()
  for (const selector of [
    TIMELOCK_SCHEDULE_BATCH_SELECTOR,
    TIMELOCK_SCHEDULE_SELECTOR,
  ]) {
    const needle = selector.slice(2).toLowerCase()
    for (
      let at = body.indexOf(needle);
      at !== -1;
      at = body.indexOf(needle, at + 1)
    )
      if (at % 2 === 0) return true
  }
  return false
}

/**
 * Reads used to pick a salt that will not collide with an existing operation.
 *
 * `hashOperationBatch` is read from the contract so the id cannot drift from the
 * timelock's own definition of it.
 */
export const TIMELOCK_OPERATION_STATE_ABI = parseAbi([
  'function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)',
  'function getTimestamp(bytes32 id) view returns (uint256)',
])

/**
 * Shared by the operation-id read and the encoder: a different predecessor in
 * either would hash to a different operation than the one scheduled.
 */
export const TIMELOCK_ZERO_PREDECESSOR =
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
 * @param values - Value per inner call; defaults to all-zero. Pass the same array
 *        given to `pickTimelockSalt`, or the id probed is not the id scheduled
 * @returns The encoded `scheduleBatch` calldata
 * @throws If `targets` is empty, `targets` and `payloads` or `targets` and
 *         `values` differ in length, a target is not a valid address, or a
 *         payload is not well-formed hex
 */
export function encodeTimelockScheduleBatch(
  targets: Address[],
  payloads: Hex[],
  salt: Hex,
  minDelay: bigint,
  values: bigint[] = targets.map(() => 0n)
): Hex {
  if (targets.length === 0)
    throw new Error('encodeTimelockScheduleBatch requires at least one call')
  if (targets.length !== payloads.length)
    throw new Error(
      `encodeTimelockScheduleBatch: targets (${targets.length}) and payloads (${payloads.length}) must have the same length`
    )
  if (targets.length !== values.length)
    throw new Error(
      `encodeTimelockScheduleBatch: targets (${targets.length}) and values (${values.length}) must have the same length`
    )

  // Defensive re-validation at the encoding boundary: callers validate already,
  // but this module is the shared encoder and a future caller may not
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
      values,
      payloads,
      TIMELOCK_ZERO_PREDECESSOR,
      salt,
      minDelay,
    ],
  })
}

/** Whether the timelock already knows an operation id, and in what state. */
export type TimelockOperationState = 'unknown' | 'pending' | 'done'

/**
 * Reads OZ's `_timestamps` value for an operation id.
 *
 * The encoding is OZ's: 0 means never scheduled, and `_DONE_TIMESTAMP` (1) is
 * written on execute, so presence alone cannot distinguish a done operation from
 * a scheduled one. `_schedule` rejects both, but the caller must treat them
 * differently.
 *
 * @param timestamp - the value `getTimestamp(id)` returned.
 * @returns whether the operation is unknown, pending, or already executed.
 */
export const classifyTimelockOperation = (
  timestamp: bigint
): TimelockOperationState => {
  if (timestamp === 0n) return 'unknown'
  if (timestamp === 1n) return 'done'

  return 'pending'
}

export interface ITimelockSaltInput {
  chainId: number
  timelockAddress: Address
  targets: Address[]
  payloads: Hex[]
  /** Bumped only to escape an operation id the timelock already knows. */
  attempt: number
}

/**
 * Derives the timelock salt from the action, so the same action yields the same
 * `scheduleBatch` calldata and a re-proposal is visible to the duplicate-proposal
 * index.
 *
 * `attempt` is in the preimage because a purely action-derived salt can be
 * scheduled only once ever — OZ keeps `_timestamps[id]` non-zero after execute —
 * so a legitimate repeat needs a way to move to a fresh id without reintroducing
 * a clock.
 *
 * @param input - the action, plus which attempt this is.
 * @returns a bytes32 salt.
 */
/**
 * The two timelock reads salt selection needs, behind whatever client a chain
 * offers: viem on EVM, TronWeb on Tron.
 */
export interface ITimelockOperationReader {
  hashOperationBatch: (
    targets: readonly Address[],
    values: readonly bigint[],
    payloads: readonly Hex[],
    predecessor: Hex,
    salt: Hex
  ) => Promise<Hex>
  getTimestamp: (operationId: Hex) => Promise<bigint>
}

/** How many salts to try before giving up on finding an unused operation id. */
export const MAX_SALT_ATTEMPTS = 16

export interface IPickTimelockSaltAction {
  chainId: number
  timelockAddress: Address
  targetAddresses: Address[]
  originalCalldatas: Hex[]
  /**
   * The values the caller will schedule. Probing an assumed all-zero array would
   * ask about a different operation than the one being created, so a taken id
   * could read as free.
   */
  values: bigint[]
}

/**
 * Picks the first action-derived salt whose operation the timelock does not
 * already know.
 *
 * OZ's `_schedule` rejects any id it already has a timestamp for, and it keeps
 * one after execute, so the action's first candidate salt is unusable for an
 * action that has run before — scheduling it would revert only after signatures
 * had been collected and the delay had elapsed.
 *
 * A pending hit refuses. Advancing past one would schedule the same batch twice
 * under two operation ids, and the second proposal's intentHash would differ, so
 * neither the timelock nor the duplicate index would stop a double execution.
 *
 * The scan is deterministic given chain state, so two proposers racing on the
 * same repeat converge on the same salt and stay deduplicated.
 *
 * @param action - the action and its chain.
 * @param reader - the timelock's own `hashOperationBatch` and `getTimestamp`.
 * @returns the salt to schedule under.
 * @throws If the timelock cannot be read, or every attempt is already taken.
 */
export const pickTimelockSaltWith = async (
  action: IPickTimelockSaltAction,
  reader: ITimelockOperationReader
): Promise<Hex> => {
  const {
    chainId,
    timelockAddress,
    targetAddresses,
    originalCalldatas,
    values,
  } = action

  // A mismatched length probes an id `scheduleBatch` can never create, so a taken
  // id reads as free and the revert lands after signatures and the full delay.
  if (originalCalldatas.length !== targetAddresses.length)
    throw new Error(
      `pickTimelockSalt: originalCalldatas (${originalCalldatas.length}) and targetAddresses (${targetAddresses.length}) must have the same length`
    )
  if (values.length !== targetAddresses.length)
    throw new Error(
      `pickTimelockSalt: values (${values.length}) and targetAddresses (${targetAddresses.length}) must have the same length`
    )

  for (let attempt = 0; attempt < MAX_SALT_ATTEMPTS; attempt++) {
    const salt = deriveTimelockSalt({
      chainId,
      timelockAddress,
      targets: targetAddresses,
      payloads: originalCalldatas,
      attempt,
    })

    const operationId = await reader.hashOperationBatch(
      targetAddresses,
      values,
      originalCalldatas,
      TIMELOCK_ZERO_PREDECESSOR,
      salt
    )

    const state = classifyTimelockOperation(
      await reader.getTimestamp(operationId)
    )

    if (state === 'unknown') return salt

    if (state === 'pending')
      throw new Error(
        `Timelock operation ${operationId} for this exact batch is already scheduled on ${timelockAddress} ` +
          `and has not executed. This proposal duplicates work already in flight — execute or cancel the ` +
          `existing operation instead of scheduling a second one. Nothing was proposed.`
      )

    consola.info(
      `Timelock operation ${operationId} for this batch has already executed; deriving the next salt.`
    )
  }

  throw new Error(
    `Could not find an unused timelock operation id for this batch after ${MAX_SALT_ATTEMPTS} attempts ` +
      `on ${timelockAddress}. That means this exact batch has been scheduled ${MAX_SALT_ATTEMPTS} times ` +
      `already — refusing to schedule rather than guess.`
  )
}

export const deriveTimelockSalt = (input: ITimelockSaltInput): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { name: 'chainId', type: 'uint256' },
        { name: 'timelock', type: 'address' },
        { name: 'targets', type: 'address[]' },
        { name: 'payloads', type: 'bytes[]' },
        { name: 'attempt', type: 'uint256' },
      ],
      [
        BigInt(input.chainId),
        input.timelockAddress,
        input.targets,
        input.payloads,
        BigInt(input.attempt),
      ]
    )
  )
