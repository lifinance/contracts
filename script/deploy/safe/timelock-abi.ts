import { parseAbi, toFunctionSelector } from 'viem'

/**
 * TimelockController ABIs + selectors shared across Safe scripts.
 *
 * Keep this file dependency-light to avoid circular imports (e.g. safe-decode-utils
 * imports from safe-utils, so safe-utils must not import safe-decode-utils).
 */
export const TIMELOCK_SCHEDULE_ABI = parseAbi([
  'function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
])

export const TIMELOCK_SCHEDULE_BATCH_ABI = parseAbi([
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
])

export const TIMELOCK_SCHEDULE_SELECTOR = toFunctionSelector(
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)'
)

export const TIMELOCK_SCHEDULE_BATCH_SELECTOR = toFunctionSelector(
  'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)'
)
