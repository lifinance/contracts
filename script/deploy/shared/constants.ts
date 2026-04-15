/**
 * Shared project-level constants
 * These constants are not network-specific and apply across the entire project
 */

import networks from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type DeploymentFileSuffixInput,
  type EVMVersion,
} from '../../common/types'

/**
 * Minimum number of signatures required for Safe multisig transactions
 * This threshold ensures adequate security for critical operations
 */
export const SAFE_THRESHOLD = 3
/** How long to wait for a Safe transaction to be confirmed before timing out (ms). */
export const CONFIRMATION_TIMEOUT = 120000 // 2 minutes
/** Default number of retry attempts for recoverable RPC/network errors (not rate limits). */
export const MAX_RETRIES = 3
/** How often to poll for transaction confirmation or status changes (ms). */
export const POLL_INTERVAL = 3000 // 3 seconds

/**
 * Centralized delay constants for consistent timing across the codebase
 *
 * Policy:
 * - INTER_CALL_DELAY: Delay between individual RPC/contract calls to avoid rate limits (500ms)
 * - INITIAL_CALL_DELAY: Delay before first call in a sequence to warm up rate limit windows (2000ms)
 * - RETRY_DELAY: Delay between retry attempts when rate limits are hit (2000ms)
 *
 * Usage:
 * - Use INTER_CALL_DELAY for delays between individual checks/calls in loops
 * - Use INITIAL_CALL_DELAY before starting a sequence of calls
 * - Use RETRY_DELAY as the default for retry loops and execWithRateLimitRetry
 */

/**
 * Delay between individual RPC/contract calls to avoid rate limits
 * Used for: spacing out calls in loops, between consecutive checks
 */
export const INTER_CALL_DELAY = 500 // 500ms

/**
 * Delay before first call in a sequence to warm up rate limit windows
 * Used for: initial delay before starting RPC calls, before batch operations
 */
export const INITIAL_CALL_DELAY = 2000 // 2s

/**
 * Delay between retry attempts when rate limits are hit
 * Used for: retry loops, execWithRateLimitRetry default delay
 */
export const RETRY_DELAY = 2000 // 2s

// File paths
export const DEPLOYMENT_FILE_SUFFIX = (
  environment: DeploymentFileSuffixInput
): '' | 'staging.' =>
  environment === EnvironmentEnum.production ? '' : 'staging.'

/** Canonical EVM zero address (all 20 bytes zero). Use instead of hardcoding the literal string. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Distinct non-placeholder EVM fork labels from `config/networks.json`, lowercased and sorted.
 * Used for Safe fallback bytecode selection and `--evmVersion` validation.
 */
export const EVM_VERSIONS: readonly EVMVersion[] = Object.freeze(
  Array.from(
    new Set(
      Object.values(networks).map((n) =>
        n.deployedWithEvmVersion.trim().toLowerCase()
      )
    )
  )
    .filter((v) => v !== '' && v !== 'n/a')
    .sort() as EVMVersion[]
)

/**
 * Fallback when `foundry.toml` is unreadable or `evm_version` is not in {@link EVM_VERSIONS}.
 * Used by {@link getFoundryDefaultEvmVersion} in `script/utils/utils.ts`.
 */
export const FOUNDRY_DEFAULT_EVM_VERSION_FALLBACK: EVMVersion = 'cancun'

/**
 * Passed to deployment logging when `solc_version` cannot be read from `foundry.toml` (optional Mongo field).
 */
export const FOUNDRY_DEFAULT_SOLC_VERSION_FALLBACK = ''

/** Minimal ABI for `IDiamondCut.diamondCut`. */
export const DIAMOND_CUT_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'facetAddress', type: 'address' },
          { name: 'action', type: 'uint8' },
          { name: 'functionSelectors', type: 'bytes4[]' },
        ],
        name: '_diamondCut',
        type: 'tuple[]',
      },
      { name: '_init', type: 'address' },
      { name: '_calldata', type: 'bytes' },
    ],
    name: 'diamondCut',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
