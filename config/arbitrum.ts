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
    address destAddr,
    uint256 l2CallValue,
    uint256 maxSubmissionCost,
    address excessFeeRefundAddress,
    address callValueRefundAddress,
    uint256 maxGas,
    uint256 gasPriceBid,
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
  rinkeby: {
    gatewayRouter: '0x70C143928eCfFaf9F5b406f7f4fC28Dc43d68380',
    inbox: '0x578BAde599406A8fE3d24Fd7f7211c0911F5B29e',
  },
}

export default config
