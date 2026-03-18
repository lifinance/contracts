/**
 * Tron-specific constants
 * These constants are tightly coupled to Tron network mechanics and should not be used for other networks.
 * For minimizing deployment cost (delegated energy, rental, fee limits), see docs/TronDeploymentCostStrategy.md.
 */

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
