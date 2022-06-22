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
}

export default config
