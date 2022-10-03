interface StargateConfig {
  [key: string]: {
    chainId: number // EVM id
    layerZeroChainId: number // Chain Id that Stargate uses
    stargateRouter: string // Stargate router address
    pools?: any // Support pools on chain
  }
}

export const PAYLOAD_ABI = [
  'bytes32', // Transaction Id
  'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requireDeposit)[]', // Swap Data
  'address', // Asset Id
  'address', // Receiver
]

export const POOLS: any = {
  USDC: {
    id: 1, // Pool Id on Stargate
    mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    rinkeby: '0x1717A0D5C8705EE89A8aD6E808268D6A826C97A4',
    bsc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    polygon: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    polygonMumbai: '0x742DfA5Aa70a8212857966D491D67B09Ce7D6ec7',
    avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    opera: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
    fantom_testnet: '0x076488D244A73DA4Fa843f5A8Cd91F655CA81a1e',
    arbitrumOne: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    arbitrumTestnet: '0x1EA8Fb2F671620767f41559b663b86B1365BBc3d',
    optimism: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
    optimisticKovan: '0x567f39d9e6d02078F357658f498F80eF087059aa',
  },
  USDT: {
    id: 2, // Pool Id on Stargate
    mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    bsc: '0x55d398326f99059fF775485246999027B3197955',
    bscTestnet: '0xF49E250aEB5abDf660d643583AdFd0be41464EfD',
    polygon: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    avalanche: '0xc7198437980c041c805A1EDcbA50c1Ce5db95118',
    avalancheFujiTestnet: '0x4A0D1092E9df255cf95D72834Ea9255132782318',
    opera: '0x049d68029688eAbF473097a2fC38ef61633A3C7A',
    arbitrumOne: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    optimism: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  },
  BUSD: {
    id: 5, // Pool Id on Stargate
    mainnet: '0x4Fabb145d64652a948d72533023f6E7A623C7C53',
    bsc: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    polygon: '0x9fB83c0635De2E815fd1c21b3a292277540C2e8d',
    avalanche: '0x19860CCB0A68fd4213aB9D8266F7bBf05A8dDe98',
  },
}

// chainId values on Stargate are not related to EVM ids.
// Since LayerZero will span EVM & non-EVM chains the chainId are proprietary
// to LayerZero's Endpoints.
// https://layerzero.gitbook.io/docs/technical-reference/mainnet/supported-chain-ids
const config: StargateConfig = {
  hardhat: {
    chainId: 1,
    layerZeroChainId: 101,
    stargateRouter: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
    pools: [POOLS.USDC, POOLS.USDT],
  },
  mainnet: {
    chainId: 1,
    layerZeroChainId: 101,
    stargateRouter: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
    pools: [POOLS.USDC, POOLS.USDT],
  },
  rinkeby: {
    chainId: 4,
    layerZeroChainId: 10001,
    stargateRouter: '0x82A0F5F531F9ce0df1DF5619f74a0d3fA31FF561',
    pools: [POOLS.USDC],
  },
  bsc: {
    chainId: 56,
    layerZeroChainId: 102,
    stargateRouter: '0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8',
    pools: [POOLS.USDT, POOLS.BUSD],
  },
  bscTestnet: {
    chainId: 97,
    layerZeroChainId: 10002,
    stargateRouter: '0xbB0f1be1E9CE9cB27EA5b0c3a85B7cc3381d8176',
    pools: [POOLS.USDT],
  },
  polygon: {
    chainId: 137,
    layerZeroChainId: 109,
    stargateRouter: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
    pools: [POOLS.USDC, POOLS.USDT],
  },
  polygonMumbai: {
    chainId: 80001,
    layerZeroChainId: 10009,
    stargateRouter: '0x817436a076060D158204d955E5403b6Ed0A5fac0',
    pools: [POOLS.USDC],
  },
  avalanche: {
    chainId: 43114,
    layerZeroChainId: 106,
    stargateRouter: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
    pools: [POOLS.USDC, POOLS.USDT],
  },
  avalancheFujiTestnet: {
    chainId: 43113,
    layerZeroChainId: 10006,
    stargateRouter: '0x13093E05Eb890dfA6DacecBdE51d24DabAb2Faa1',
    pools: [POOLS.USDC],
  },
  opera: {
    chainId: 250,
    layerZeroChainId: 112,
    stargateRouter: '0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6',
    pools: [POOLS.USDC],
  },
  fantom_testnet: {
    chainId: 4002,
    layerZeroChainId: 10012,
    stargateRouter: '0xa73b0a56B29aD790595763e71505FCa2c1abb77f',
    pools: [POOLS.USDC],
  },
  arbitrumOne: {
    chainId: 42161,
    layerZeroChainId: 110,
    stargateRouter: '0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614',
    pools: [POOLS.USDC, POOLS.USDT],
  },
  arbitrumTestnet: {
    chainId: 421611,
    layerZeroChainId: 10010,
    stargateRouter: '0x6701D9802aDF674E524053bd44AA83ef253efc41',
    pools: [POOLS.USDC],
  },
  optimism: {
    chainId: 10,
    layerZeroChainId: 111,
    stargateRouter: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
    pools: [POOLS.USDC],
  },
  optimisticKovan: {
    chainId: 69,
    layerZeroChainId: 10011,
    stargateRouter: '0xCC68641528B948642bDE1729805d6cf1DECB0B00',
    pools: [POOLS.USDC],
  },
}

export default config
