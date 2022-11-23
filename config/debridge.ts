interface DeBridgeConfig {
  [key: string]: {
    chainId: number, // Chain Id
    deBridgeGate: string // DeBridgeGate contract address,
  }
}

// Flags set specific flows for call data execution
export const flags = {
    // Flag to unwrap ETH
    UNWRAP_ETH: 0,
    // Flag to revert if external call fails
    REVERT_IF_EXTERNAL_FAIL: 1,
    // Flag to call proxy with a sender contract
    PROXY_WITH_SENDER: 2,
    // Data is hash in DeBridgeGate send method
    SEND_HASHED_DATA: 3,
    // First 24 bytes from data is gas limit for external call
    SEND_EXTERNAL_CALL_GAS_LIMIT: 4,
    // Support tx bundling (multi-send) for externall call
    MULTI_SEND: 5,
}

const config: DeBridgeConfig = {
  hardhat: {
    chainId: 1,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  mainnet: {
    chainId: 1,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  bsc: {
    chainId: 56,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  heco: {
    chainId: 128,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  polygon: {
    chainId: 137,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  arbitrum: {
    chainId: 42161,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  avalanche: {
    chainId: 43114,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
  fantom: {
    chainId: 250,
    deBridgeGate: '0x43dE2d77BF8027e25dBD179B491e8d64f38398aA',
  },
}

export default config
