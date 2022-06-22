interface PolygonBridgeConfig {
  [key: string]: {
    rootChainManager: string // RootChainManager contract address
    erc20Predicate: string // ERC20Predicate contract address
  }
}

const config: PolygonBridgeConfig = {
  hardhat: {
    rootChainManager: '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77',
    erc20Predicate: '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf',
  },
  mainnet: {
    rootChainManager: '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77',
    erc20Predicate: '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf',
  },
}

export default config
