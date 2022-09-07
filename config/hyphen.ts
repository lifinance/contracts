interface HyphenConfig {
  [key: string]: {
    hyphenRouter: string
  }
}

// based on LiquidityPool in https://docs.biconomy.io/products/hyphen-instant-cross-chain-transfers/contract-addresses
const config: HyphenConfig = {
  hardhat: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  mainnet: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  polygon: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  avalanche: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  bsc: {
    hyphenRouter: '0x94D3E62151B12A12A4976F60EdC18459538FaF08',
  },
  optimisticEthereum: {
    hyphenRouter: '0x856cb5c3cbbe9e2e21293a644aa1f9363cee11e8',
  },
  arbitrumOne: {
    hyphenRouter: '0x856cb5c3cBBe9e2E21293A644aA1f9363CEE11E8',
  },

  // Testnets
  goerli: {
    hyphenRouter: '0xE61d38cC9B3eF1d223b177090f3FD02b0B3412e7',
  },
  polygonMumbai: {
    hyphenRouter: '0xb831F0848A055b146a0b13D54cfFa6C1FE201b83',
  },
  avalancheFujiTestnet: {
    hyphenRouter: '0x07d2d1690D13f5fD9F9D51a96CEe211F6a845AC5',
  },
  bscTestnet: {
    hyphenRouter: '0xDbF976e42bC51D801E0DB572ED279EA2F46c3BbD',
  },
  optimisticKovan: {
    hyphenRouter: '0x5b330816329E2d52Dda90e30D70dC9ea51d4503B',
  },
  arbitrumTestnet: {
    hyphenRouter: '0xa948d26475d1f8a40a1085ec93a46d5934887599',
  },
}

export default config
