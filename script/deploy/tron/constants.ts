// Safety margin for energy estimation to prevent transaction failures
export const DEFAULT_SAFETY_MARGIN = 1.5 // 50% buffer for standard operations

// Diamond operations require significantly more energy than regular transactions
// This multiplier ensures diamond cut operations don't fail due to insufficient energy
export const DIAMOND_CUT_ENERGY_MULTIPLIER = 10 // Safety multiplier for diamond operations

// Maximum TRX amount willing to spend on transaction fees
// Acts as a safety cap to prevent excessive fee consumption
export const DEFAULT_FEE_LIMIT_TRX = 5000 // Default fee limit in TRX for transaction execution

// Triggers console warning when deployer balance falls below this threshold
// Helps prevent deployment failures due to insufficient funds
export const MIN_BALANCE_WARNING = 100 // Minimum TRX balance before warning is displayed

// Minimum balance required for contract resource registration on Tron
// Tron requires contracts to have resources delegated for user transactions
export const MIN_BALANCE_REGISTRATION = 5 // Minimum TRX balance for resource registration

// Timeouts and retries
export const CONFIRMATION_TIMEOUT = 120000 // 2 minutes
export const MAX_RETRIES = 3
export const POLL_INTERVAL = 3000 // 3 seconds

// Transaction constants
// Extra bytes added when encoding transaction data from hex to protobuf format
// Tron uses protobuf for transaction serialization, requiring additional overhead
export const DATA_HEX_PROTOBUF_EXTRA = 3

// Maximum size in bytes for return data from contract calls
export const MAX_RESULT_SIZE_IN_TX = 64

// Size of a single signature in bytes (Tron uses ECDSA signatures)
export const A_SIGNATURE = 67

// File paths
export const DEPLOYMENT_FILE_SUFFIX = (environment: string) =>
  environment === 'production' ? '' : 'staging.'

// Common addresses
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const TRON_ZERO_ADDRESS = '410000000000000000000000000000000000000000'
