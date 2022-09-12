interface AmarokConfig {
  [key: string]: {
    connextHandler: string
    domain: number
  }
}

const config: AmarokConfig = {
  hardhat: {
    connextHandler: '',
    domain: 0,
  },
  mainnet: {
    connextHandler: '',
    domain: 0,
  },
  goerli: {
    connextHandler: '0xB4C1340434920d70aD774309C75f9a4B679d801e',
    domain: 1735353714,
  },
  optimism_goerli: {
    connextHandler: '0xe37f1f55eab648dA87047A03CB03DeE3d3fe7eC7',
    domain: 1735356532,
  },
}

export default config
