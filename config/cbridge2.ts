interface cBridgeConfig {
  [key: string]: {
    cBridge: string
    chainId: number
  }
}

// based on https://cbridge-docs.celer.network/reference/contract-addresses
// Mainnets: https://cbridge-prod2.celer.network/v2/getTransferConfigsForAll
// Testnets: https://cbridge-v2-test.celer.network/v2/getTransferConfigsForAll
const config: cBridgeConfig = {
  // leave cBridgeConfig as '' if you want to deploy a router with deployments
  hardhat: {
    cBridge: '0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820',
    chainId: 1,
  },
  mainnet: {
    cBridge: '0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820',
    chainId: 1,
  },
  optimisticEthereum: {
    cBridge: '0x9D39Fc627A6d9d9F8C831c16995b209548cc3401',
    chainId: 10,
  },
  // Crab Smart Chain
  // crab: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 44,
  // },
  bsc: {
    cBridge: '0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF',
    chainId: 56,
  },
  // Syscoin
  // syscoin: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 57,
  // },
  // Ontology EVM
  // ontology: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 57,
  // },
  okx: {
    cBridge: '0x6a2d262D56735DbA19Dd70682B39F6bE9a931D98',
    chainId: 66,
  },
  xdai: {
    cBridge: '0x3795C36e7D12A8c252A20C5a7B455f7c57b60283',
    chainId: 100,
  },
  heco: {
    cBridge: '0xBB7684Cc5408F4DD0921E5c2Cadd547b8f1AD573',
    chainId: 128,
  },
  polygon: {
    cBridge: '0x88DCDC47D2f83a99CF0000FDF667A468bB958a78',
    chainId: 137,
  },
  opera: {
    cBridge: '0x374B8a9f3eC5eB2D97ECA84Ea27aCa45aa1C57EF',
    chainId: 250,
  },
  boba: {
    cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
    chainId: 288,
  },
  // Shiden
  // shiden: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 336,
  // },
  // SX Network
  // sx: {
  //   cBridge: '0x9B36f165baB9ebe611d491180418d8De4b8f3a1f',
  //   chainId: 336,
  // },
  // Astar
  // astar: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 336,
  // },
  // Clover
  // clover: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 1024,
  // },
  // Conflux
  // conflux: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 1030,
  // },
  // Metis Mainnet
  // metis: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 1088,
  // },
  moonbeam: {
    cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
    chainId: 1284,
  },
  moonriver: {
    cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
    chainId: 1285,
  },
  // Milkomeda Cardano
  // milkomeda: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 2001,
  // },
  // Kava EVM Co-Chain
  // kava: {
  //   cBridge: '0xb51541df05DE07be38dcfc4a80c05389A54502BB',
  //   chainId: 2222,
  // },
  // Evmos
  evmos: {
    cBridge: '0x5F52B9d1C0853da636e178169e6B426E4cCfA813',
    chainId: 9001,
  },
  // Ape Chain
  // ape: {
  //   cBridge: '0x9B36f165baB9ebe611d491180418d8De4b8f3a1f',
  //   chainId: 16350,
  // },
  arbitrumOne: {
    cBridge: '0x1619DE6B6B20eD217a58d00f37B9d47C7663feca',
    chainId: 42161,
  },
  celo: {
    cBridge: '0xBB7684Cc5408F4DD0921E5c2Cadd547b8f1AD573',
    chainId: 42220,
  },
  // Oasis Emerald
  // oasis: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 42262,
  // },
  avalanche: {
    cBridge: '0xef3c714c9425a8F3697A9C969Dc1af30ba82e5d4',
    chainId: 43114,
  },
  // REI Network
  // rei: {
  //   cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
  //   chainId: 47805,
  // },
  // Nervos Godwoken
  // nervos: {
  //   cBridge: '0x4C882ec256823eE773B25b414d36F92ef58a7c0C',
  //   chainId: 71402,
  // },
  // Swimmer Network
  // swimmer: {
  //   cBridge: '0xb51541df05DE07be38dcfc4a80c05389A54502BB',
  //   chainId: 73772,
  // },
  // PlatON
  // platOn: {
  //   cBridge: '0xBf2B2757F0B2a2f70136C4A6627e99d8ec5cC7b9',
  //   chainId: 210425,
  // },
  // Flow Mainnet
  // flow: {
  //   cBridge: '0x00000000000000000000000008dd120226EC2213',
  //   chainId: 12340001,
  // },
  // Aurora
  aurora: {
    cBridge: '0x841ce48F9446C8E281D3F1444cB859b4A6D0738C',
    chainId: 1313161554,
  },
  // Harmony
  harmony: {
    cBridge: '0x78a21C1D3ED53A82d4247b9Ee5bF001f4620Ceec',
    chainId: 1666600000,
  },

  // Testnets
  goerli: {
    cBridge: '0x358234B325EF9eA8115291A8b81b7d33A2Fa762D',
    chainId: 5,
  },
  optimisticKovan: {
    cBridge: '0x265B25e22bcd7f10a5bD6E6410F10537Cc7567e8',
    chainId: 69,
  },
  bscTestnet: {
    cBridge: '0xf89354F314faF344Abd754924438bA798E306DF2',
    chainId: 97,
  },
  // Fantom Testnet
  // _: {
  //   cBridge: '0xFA78cBa4ebbf8fE28B4fC1468948F16Fda2752b3',
  //   chainId: 4002,
  // },
  // Moonriver Alpha
  // _: {
  //   cBridge: '0x841ce48f9446c8e281d3f1444cb859b4a6d0738c',
  //   chainId: 1287,
  // },
  // OASIS Testnet
  // _: {
  //   cBridge: '0xe47ec50d886a383eb8522f9a8850050b7c9f6f9f',
  //   chainId: 42261,
  // },
}

export default config
