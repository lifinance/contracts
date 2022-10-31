interface ArbitrumBridgeConfig {
  [key: string]: {
    gatewayRouter: string // GatewayRouter contract address,
    inbox: string // Inbox contract address,
  }
}

const config: ArbitrumBridgeConfig = {
  hardhat: {
    gatewayRouter: '0x4c7708168395aEa569453Fc36862D2ffcDaC588c',
    inbox: '0x6BEbC4925716945D46F0Ec336D5C2564F419682C',
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
