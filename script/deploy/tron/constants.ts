// Energy and cost constants
export const ENERGY_PRICE = 0.00021 // TRX per energy unit
export const BANDWIDTH_PRICE = 0.001 // TRX per bandwidth point
export const DEFAULT_SAFETY_MARGIN = 1.5 // 50% buffer
export const DIAMOND_CUT_ENERGY_MULTIPLIER = 10 // Safety multiplier for diamond operations
export const DEFAULT_FEE_LIMIT_TRX = 5000 // Default fee limit in TRX
export const MIN_BALANCE_WARNING = 100 // Minimum balance before warning
export const MIN_BALANCE_REGISTRATION = 5 // Minimum balance for registration

// Timeouts and retries
export const CONFIRMATION_TIMEOUT = 120000 // 2 minutes
export const MAX_RETRIES = 3
export const POLL_INTERVAL = 3000 // 3 seconds

// Transaction constants
export const DATA_HEX_PROTOBUF_EXTRA = 3
export const MAX_RESULT_SIZE_IN_TX = 64
export const A_SIGNATURE = 67

// File paths
export const DEPLOYMENT_FILE_SUFFIX = (environment: string) =>
  environment === 'production' ? '' : 'staging.'

// Common addresses
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const TRON_ZERO_ADDRESS = '410000000000000000000000000000000000000000'
