interface MultichainConfig {
  [key: string]: {
    multichainRouter: string
  }
}

const config: MultichainConfig = {
  // leave multichainRouter as '' if you want to deploy a router with deployments
  hardhat: {
    multichainRouter: '',
  },
  // Anyswap v4 router
  mainnet: {
    multichainRouter: '0x6b7a87899490EcE95443e979cA9485CBE7E71522',
  },
  rinkeby: {
    multichainRouter: '-',
  },
  ropsten: {
    multichainRouter: '-',
  },
  goerli: {
    multichainRouter: '-',
  },
  polygon: {
    multichainRouter: '-',
  },
  xdai: {
    multichainRouter: '-',
  },
  bsc: {
    multichainRouter: '-',
  },
  fantom: {
    multichainRouter: '-',
  },
  mumbai: {
    multichainRouter: '-',
  },
  arbitrum_rinkeby: {
    multichainRouter: '-',
  },
}

export default config
