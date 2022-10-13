interface ArbitrumBridgeConfig {
  [key: string]: {
    gatewayRouter: string // GatewayRouter contract address,
    inbox: string // Inbox contract address,
  }
}

export const DEFAULT_SUBMISSION_PRICE_PERCENT_INCREASE = 340
// Temporary workaround for incorrect gas estimation from NodeInterface when there is gas refund
export const DEFAULT_MAX_GAS_PERCENT_INCREASE = 50

export const ARB_RETRYABLE_TX_ADDRESS =
  '0x000000000000000000000000000000000000006E'
export const NODE_INTERFACE_ADDRESS =
  '0x00000000000000000000000000000000000000C8'

export const GET_SUBMISSION_PRICE_ABI = [
  `
  function getSubmissionPrice(uint256 calldataSize)
    external
    view
    returns (uint256, uint256)
  `,
]
export const ESTIMATE_RETRYABLE_TICKET_ABI = [
  `
  function estimateRetryableTicket(
    address sender,
    uint256 deposit,
    address to,
    uint256 l2CallValue,
    address excessFeeRefundAddress,
    address callValueRefundAddress,
    bytes data
  )
    external
    view
    returns (uint256, uint256)
  `,
]

const config: ArbitrumBridgeConfig = {
  hardhat: {
    gatewayRouter: '0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef',
    inbox: '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f',
  },
  mainnet: {
    gatewayRouter: '0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef',
    inbox: '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f',
  },
  goerli: {
    gatewayRouter: '0x4c7708168395aEa569453Fc36862D2ffcDaC588c',
    inbox: '0x6BEbC4925716945D46F0Ec336D5C2564F419682C',
  },
}

export default config
