interface HyphenConfig {
  [key: string]: {
    hyphenRouter: string
  }
}

// based on LiquidityPool in https://docs.biconomy.io/products/hyphen-instant-cross-chain-transfers/contract-addresses
const config: HyphenConfig = {
  // leave hyphenRouter as '' if you want to deploy a router with deployments
  hardhat: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  mainnet: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  rinkeby: {
    hyphenRouter: '-',
  },
  ropsten: {
    hyphenRouter: '-',
  },
  goerli: {
    hyphenRouter: '0xE61d38cC9B3eF1d223b177090f3FD02b0B3412e7',
  },
  polygon: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
  xdai: {
    hyphenRouter: '-',
  },
  bsc: {
    hyphenRouter: '-',
  },
  fantom: {
    hyphenRouter: '-',
  },
  mumbai: {
    hyphenRouter: '0xb831F0848A055b146a0b13D54cfFa6C1FE201b83',
  },
  arbitrum_rinkeby: {
    hyphenRouter: '-',
  },
  avax: {
    hyphenRouter: '0x2A5c2568b10A0E826BfA892Cf21BA7218310180b',
  },
}

export default config
