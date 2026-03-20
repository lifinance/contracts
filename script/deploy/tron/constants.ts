/**
 * Tron-specific constants
 * These constants are tightly coupled to Tron network mechanics and should not be used for other networks.
 * For minimizing deployment cost (delegated energy, rental, fee limits), see docs/TronDeploymentCostStrategy.md.
 */

import * as path from 'path'
import { fileURLToPath } from 'url'

import type { Hex } from 'viem'

import type { SupportedChain } from '../../common/types'

const __tronConstantsDir = path.dirname(fileURLToPath(import.meta.url))

/** Base directory for Safe v1.4.1 Foundry artifacts (`safe/london/out`). */
export const TRON_SAFE_ARTIFACTS_BASE = path.join(
  __tronConstantsDir,
  '../../../safe/london/out'
)

/** Temp file for singleton/factory addresses during Safe deploy; not written to networks.json. */
export const TRON_SAFE_DEPLOY_TEMP_JSON_PATH = path.join(
  process.cwd(),
  'config',
  '.tron-safe-deploy-temp.json'
)

/** `networks.json` / config key for production Tron deployment scripts. */
export const TRON_DEPLOY_NETWORK: SupportedChain = 'tron'

/** TTL for caching energy and bandwidth prices from the Tron API (ms). */
export const PRICE_CACHE_TTL_MS = 60 * 60 * 1000

/** Fallback energy price in TRX per energy unit if `getEnergyPrices` fails. */
export const FALLBACK_ENERGY_PRICE_TRX = 0.00021

/** Fallback bandwidth price in TRX per bandwidth point if `getBandwidthPrices` fails. */
export const FALLBACK_BANDWIDTH_PRICE_TRX = 0.001

/** Default periphery contracts deployed/registered by deploy-and-register-periphery. */
export const TRON_PERIPHERY_CONTRACTS = [
  'ERC20Proxy',
  'Executor',
  'FeeCollector',
  'FeeForwarder',
  'TokenWrapper',
] as const

/** Facet batches for split diamondCut registration (order matters). */
export const TRON_DIAMOND_FACET_GROUPS: string[][] = [
  ['DiamondLoupeFacet'],
  ['OwnershipFacet', 'WithdrawFacet', 'AccessManagerFacet'],
  ['WhitelistManagerFacet', 'PeripheryRegistryFacet'],
  ['GenericSwapFacet', 'GenericSwapFacetV3'],
  ['CalldataVerificationFacet', 'EmergencyPauseFacet'],
]

/** Topic0 for Safe `ProxyCreation` event (no `0x` prefix; lowercase hex). */
export const TRON_SAFE_PROXY_CREATION_TOPIC_HEX =
  '4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235' // [pre-commit-checker: not a secret]

/** Minimal ABI for `SafeProxyFactory.createProxyWithNonce`. */
export const TRON_SAFE_PROXY_FACTORY_ABI = [
  {
    inputs: [
      { internalType: 'address', name: '_singleton', type: 'address' },
      { internalType: 'bytes', name: 'initializer', type: 'bytes' },
      { internalType: 'uint256', name: 'saltNonce', type: 'uint256' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ internalType: 'address', name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** Minimal ABI for calling `setup` on a Safe proxy. */
export const TRON_SAFE_SETUP_ABI = [
  {
    inputs: [
      { internalType: 'address[]', name: '_owners', type: 'address[]' },
      { internalType: 'uint256', name: '_threshold', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
      { internalType: 'address', name: 'fallbackHandler', type: 'address' },
      { internalType: 'address', name: 'paymentToken', type: 'address' },
      { internalType: 'uint256', name: 'payment', type: 'uint256' },
      {
        internalType: 'address payable',
        name: 'paymentReceiver',
        type: 'address',
      },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

export const TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR = '0x7200b829' as Hex

/** Minimal ABI fragment for Safe `getTransactionHash`. */
export const TRON_SAFE_GET_TX_HASH_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    name: 'getTransactionHash',
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Safety margin for energy estimation to prevent transaction failures
export const DEFAULT_SAFETY_MARGIN = 1.2 // 20% buffer for standard operations

// Diamond operations require significantly more energy than regular transactions
// This multiplier ensures diamond cut operations don't fail due to insufficient energy
export const DIAMOND_CUT_ENERGY_MULTIPLIER = 10 // Safety multiplier for diamond operations

// Safety multiplier for Safe createProxyWithNonce + setup (proxy creation) energy estimate
export const CREATE_PROXY_SAFETY_MARGIN = 1.2

// Maximum TRX amount willing to spend on transaction fees
// Acts as a safety cap to prevent excessive fee consumption
export const DEFAULT_FEE_LIMIT_TRX = 5000 // Default fee limit in TRX for transaction execution

// Triggers console warning when deployer balance falls below this threshold
// Helps prevent deployment failures due to insufficient funds
export const MIN_BALANCE_WARNING = 100 // Minimum TRX balance before warning is displayed

// Minimum balance required for contract resource registration on Tron
// Tron requires contracts to have resources delegated for user transactions
export const MIN_BALANCE_REGISTRATION = 5 // Minimum TRX balance for resource registration

// Bandwidth calculation constants
// Used to calculate transaction bandwidth consumption on Tron
// Formula: rawDataLength + DATA_HEX_PROTOBUF_EXTRA + MAX_RESULT_SIZE_IN_TX + (signatures * A_SIGNATURE)
// Bandwidth is consumed for every transaction (1 bandwidth point = 1 byte of transaction size)

// Extra bytes added when encoding transaction data from hex to protobuf format
// Tron uses protobuf for transaction serialization, requiring additional overhead
export const DATA_HEX_PROTOBUF_EXTRA = 3

// Maximum size in bytes reserved for return data from contract calls
export const MAX_RESULT_SIZE_IN_TX = 64

// Size of a single ECDSA signature in bytes on Tron
export const A_SIGNATURE = 67

// Tron-specific zero address (41 prefix instead of 0x)
export const TRON_ZERO_ADDRESS = '410000000000000000000000000000000000000000'

// Delay (ms) before each RPC call during periphery registration/verification to avoid 429 rate limits
export const REGISTRATION_RPC_DELAY_MS = 8000

// Delay (ms) between retries when registration/verification RPC returns 429
export const REGISTRATION_RETRY_DELAY_MS = 10000

/**
 * 50 TRX in SUN — shared bound for script fee limits (periphery registration cap, Safe exec default).
 */
export const TRON_SCRIPT_FEE_LIMIT_50_TRX_SUN = 50_000_000

/** Min/max fee limit (SUN) for registerPeripheryContract prompts and bounds checks. */
export const REGISTER_PERIPHERY_FEE_LIMIT_MIN_SUN = 1_000_000 // 1 TRX
export const REGISTER_PERIPHERY_FEE_LIMIT_MAX_SUN =
  TRON_SCRIPT_FEE_LIMIT_50_TRX_SUN

/** Default `fee_limit` (SUN) for Safe `execTransaction` via `wallet/triggersmartcontract`. */
export const TRON_SAFE_EXEC_DEFAULT_FEE_LIMIT_SUN =
  TRON_SCRIPT_FEE_LIMIT_50_TRX_SUN

/** Env var overriding {@link TRON_SAFE_EXEC_DEFAULT_FEE_LIMIT_SUN} (positive integer SUN). */
export const TRON_SAFE_EXEC_FEE_LIMIT_SUN_ENV =
  'TRON_SAFE_EXEC_FEE_LIMIT_SUN' as const

/** Poll interval (ms) after broadcasting Safe exec while waiting for `getTransactionInfo`. */
export const TRON_SAFE_EXEC_CONFIRM_POLL_MS = 2_000

/** Default max wait (ms) for Tron Safe exec confirmation polling (Tron indexing is slower than typical EVM). */
export const TRON_SAFE_EXEC_CONFIRM_TIMEOUT_MS_DEFAULT = 100_000

/**
 * High `fee_limit` (SUN) for `wallet/triggerconstantcontract` estimation / deployment simulation only.
 */
export const TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN = 1_000_000_000
