interface WormholeConfig {
  [key: string]: {
    chainId: number
    wormholeChainId: number
    wormholeRouter: string
  }
}

const config: WormholeConfig = {
  // leave wormholeRouter as '' if you want to deploy a router with deployments
  hardhat: {
    chainId: 137,
    wormholeChainId: 5,
    wormholeRouter: '0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE',
  },
  mainnet: {
    chainId: 1,
    wormholeChainId: 2,
    wormholeRouter: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
  },
  bsc: {
    chainId: 56,
    wormholeChainId: 4,
    wormholeRouter: '0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7',
  },
  polygon: {
    chainId: 137,
    wormholeChainId: 5,
    wormholeRouter: '0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE',
  },
  avalanche: {
    chainId: 43114,
    wormholeChainId: 6,
    wormholeRouter: '0x0e082F06FF657D94310cB8cE8B0D9a04541d8052',
  },
  oasis: {
    chainId: 4262,
    wormholeChainId: 7,
    wormholeRouter: '0xfE8cD454b4A1CA468B57D79c0cc77Ef5B6f64585',
  },
  aurora: {
    chainId: 1313161554,
    wormholeChainId: 9,
    wormholeRouter: '0x51b5123a7b0F9b2bA265f9c4C8de7D78D52f510F',
  },
  fantom: {
    chainId: 250,
    wormholeChainId: 10,
    wormholeRouter: '0x7C9Fc5741288cDFdD83CeB07f3ea7e22618D79D2',
  },
  karura: {
    chainId: 686,
    wormholeChainId: 11,
    wormholeRouter: '0xae9d7fe007b3327AA64A32824Aaac52C42a6E624',
  },
  acala: {
    chainId: 787,
    wormholeChainId: 12,
    wormholeRouter: '0xae9d7fe007b3327AA64A32824Aaac52C42a6E624',
  },
  klaytn: {
    chainId: 8217,
    wormholeChainId: 13,
    wormholeRouter: '0x5b08ac39EAED75c0439FC750d9FE7E1F9dD0193F',
  },
  celo: {
    chainId: 42220,
    wormholeChainId: 14,
    wormholeRouter: '0x796Dff6D74F3E27060B71255Fe517BFb23C93eed',
  },
  moonbeam: {
    chainId: 1284,
    wormholeChainId: 16,
    wormholeRouter: '0xb1731c586ca89a23809861c6103f0b96b3f57d92',
  },
  solana: {
    chainId: 1151111081099710,
    wormholeChainId: 1,
    wormholeRouter: '-',
  },
  goerli: {
    chainId: 5,
    wormholeChainId: 2,
    wormholeRouter: '0xF890982f9310df57d00f659cf4fd87e65adEd8d7',
  },
  mumbai: {
    chainId: 80001,
    wormholeChainId: 5,
    wormholeRouter: '0x377D55a7928c046E18eEbb61977e714d2a76472a',
  },
  fuji: {
    chainId: 43113,
    wormholeChainId: 42261,
    wormholeRouter: '0x61E44E506Ca5659E6c0bba9b678586fA2d729756',
  },
}

export default config
