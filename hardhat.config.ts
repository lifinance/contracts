import 'dotenv/config'
import { HardhatUserConfig } from 'hardhat/types'
import 'hardhat-deploy'
import '@nomiclabs/hardhat-ethers'
import 'hardhat-gas-reporter'
import '@typechain/hardhat'
import 'solidity-coverage'
import { node_url, accounts } from './utils/network'
import '@nomiclabs/hardhat-etherscan'
import '@tenderly/hardhat-tenderly'
import './plugins/relay'
import { ethers } from 'hardhat'

require('./tasks/generateDiamondABI.ts')

const PKEY = process.env.PRIVATE_KEY || null

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.13',
        settings: {
          optimizer: {
            enabled: true,
            runs: 10000,
          },
        },
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
    simpleERC20Beneficiary: 1,
  },
  networks: {
    hardhat: {
      chainId: 1337,
      initialBaseFeePerGas: 0, // to fix : https://github.com/sc-forks/solidity-coverage/issues/652, see https://github.com/sc-forks/solidity-coverage/issues/652#issuecomment-896330136
      // process.env.HARDHAT_FORK will specify the network that the fork is made from.
      // this line ensure the use of the corresponding accounts
      accounts: accounts(process.env.HARDHAT_FORK),
      forking: process.env.HARDHAT_FORK
        ? {
            // TODO once PR merged : network: process.env.HARDHAT_FORK,
            url: node_url(process.env.HARDHAT_FORK),
            blockNumber: process.env.HARDHAT_FORK_NUMBER
              ? parseInt(process.env.HARDHAT_FORK_NUMBER)
              : undefined,
          }
        : undefined,
    },
    localhost: {
      url: node_url('localhost'),
      accounts: PKEY ? [PKEY] : accounts(),
    },
    mainnet: {
      url: node_url('mainnet'),
      accounts: PKEY ? [PKEY] : accounts('mainnet'),
    },
    polygon: {
      url: node_url('polygon'),
      accounts: PKEY ? [PKEY] : accounts('polygon'),
    },
    xdai: {
      url: node_url('xdai'),
      accounts: PKEY ? [PKEY] : accounts('xdai'),
    },
    bsc: {
      url: node_url('bsc'),
      accounts: PKEY ? [PKEY] : accounts('bsc'),
    },
    opera: {
      url: node_url('opera'),
      accounts: PKEY ? [PKEY] : accounts('opera'),
    },
    avalanche: {
      chainId: 43114,
      url: node_url('avalanche'),
      accounts: PKEY ? [PKEY] : accounts('avalanche'),
    },
    moonriver: {
      url: node_url('moonriver'),
      accounts: PKEY ? [PKEY] : accounts('moonriver'),
    },
    arbitrumOne: {
      url: node_url('arbitrumOne'),
      accounts: PKEY ? [PKEY] : accounts('arbitrumOne'),
    },
    optimisticEthereum: {
      url: node_url('optimisticEthereum'),
      accounts: PKEY ? [PKEY] : accounts('optimisticEthereum'),
    },
    celo: {
      url: node_url('celo'),
      accounts: PKEY ? [PKEY] : accounts('celo'),
    },
    moonbeam: {
      url: node_url('moonbeam'),
      accounts: PKEY ? [PKEY] : accounts('moonbeam'),
    },
    fuse: {
      url: node_url('fuse'),
      accounts: PKEY ? [PKEY] : accounts('fuse'),
    },
    boba: {
      chainId: 288,
      url: node_url('boba'),
      accounts: PKEY ? [PKEY] : accounts('boba'),
    },
    harmony: {
      url: node_url('harmony'),
      accounts: PKEY ? [PKEY] : accounts('harmony'),
    },
    okx: {
      url: node_url('okx'),
      accounts: PKEY ? [PKEY] : accounts('okx'),
    },
    heco: {
      chainId: 128,
      url: node_url('heco'),
      accounts: PKEY ? [PKEY] : accounts('heco'),
    },
    cronos: {
      chainId: 25,
      url: node_url('cronos'),
      accounts: PKEY ? [PKEY] : accounts('cronos'),
    },

    // Testnets
    rinkeby: {
      url: node_url('rinkeby'),
      accounts: PKEY ? [PKEY] : accounts('rinkeby'),
    },
    ropsten: {
      url: node_url('ropsten'),
      accounts: PKEY ? [PKEY] : accounts('ropsten'),
    },
    kovan: {
      url: node_url('kovan'),
      accounts: PKEY ? [PKEY] : accounts('kovan'),
    },
    goerli: {
      url: node_url('goerli'),
      accounts: PKEY ? [PKEY] : accounts('goerli'),
    },
    arbitrumTestnet: {
      url: node_url('arbitrumTestnet'),
      accounts: PKEY ? [PKEY] : accounts('arbitrumTestnet'),
    },
    polygonMumbai: {
      url: node_url('polygonMumbai'),
      accounts: PKEY ? [PKEY] : accounts('polygonMumbai'),
    },
    bscTestnet: {
      url: node_url('bscTestnet'),
      accounts: PKEY ? [PKEY] : accounts('bscTestnet'),
    },
    avalancheFujiTestnet: {
      url: node_url('avalancheFujiTestnet'),
      accounts: PKEY ? [PKEY] : accounts('avalancheFujiTestnet'),
    },
    optimisticKovan: {
      url: node_url('optimisticKovan'),
      accounts: PKEY ? [PKEY] : accounts('optimisticKovan'),
    },
    evmos: {
      url: node_url('evmos'),
      accounts: PKEY ? [PKEY] : accounts('evmos'),
    },
    aurora: {
      url: node_url('aurora'),
      accounts: PKEY ? [PKEY] : accounts('aurora'),
    },
    metis: {
      url: node_url('metis'),
      accounts: PKEY ? [PKEY] : accounts('metis'),
    },
  },
  paths: {
    sources: 'src',
  },
  gasReporter: {
    currency: 'USD',
    gasPrice: 100,
    enabled: process.env.REPORT_GAS ? true : false,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    maxMethodDiff: 10,
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5',
  },
  mocha: {
    timeout: 0,
  },
  tenderly: {
    project: 'production',
    username: 'tenderly@li.finance',
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY,
      rinkeby: process.env.RINKEBY_ETHERSCAN_API_KEY,
      ropsten: process.env.ROPSTEN_ETHERSCAN_API_KEY,
      kovan: process.env.KOVAN_ETHERSCAN_API_KEY,
      goerli: process.env.GOERLI_ETHERSCAN_API_KEY,
      polygon: process.env.POLYGON_ETHERSCAN_API_KEY,
      polygonMumbai: process.env.POLYGON_MUMBAI_ETHERSCAN_API_KEY,
      xdai: process.env.XDAI_ETHERSCAN_API_KEY,
      bsc: process.env.BSC_ETHERSCAN_API_KEY,
      bscTestnet: process.env.BSC_TESTNET_ETHERSCAN_API_KEY,
      opera: process.env.OPERA_ETHERSCAN_API_KEY,
      avalanche: process.env.AVALANCHE_ETHERSCAN_API_KEY,
      avalancheFujiTestnet:
        process.env.AVALANCHE_FUJI_TESTNET_ETHERSCAN_API_KEY,
      moonriver: process.env.MOONRIVER_ETHERSCAN_API_KEY,
      moonbeam: process.env.MOONBEAM_ETHERSCAN_API_KEY,
      arbitrumOne: process.env.ARBITRUMONE_ETHERSCAN_API_KEY,
      arbitrumTestnet: process.env.ARBITRUM_TESTNET_ETHERSCAN_API_KEY,
      optimisticEthereum: process.env.OPTIMISTICETHEREUM_ETHERSCAN_API_KEY,
      optimisticKovan: process.env.OPTIMISTICKOVAN_ETHERSCAN_API_KEY,
      heco: process.env.HECO_ETHERSCAN_API_KEY,
      aurora: process.env.AURORA_ETHERSCAN_API_KEY,
    },
  },
  deterministicDeployment: process.env.STAGING
    ? undefined
    : (network: string) => {
        const deployments: Record<string, string> = {
          1: '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf326a0b1fd9f4102283a663738983f1aac789e979e220a1b649faa74033f507b911af5a061dd0f2f6f2341ee95913cf94b3b8a49cac9fdd7be6310da7acd7a96e31958d7',
          3: '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf329a0fcbc37c4f06154e91c2ae76cb8ee1e9fc8984237652ced1d286f1998232d9831a03d0b74194f7ad804a2df756ca0f69f499b500fd3d2f94b3ea1b8a3150805c394',
          4: '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf32ca0f84fcc5918d8b1381ca3f6f429ba019eb728ddce01312d1ff77c0fbfaceea15aa075811a874ab7efbd53904f77f513b84f93d3acc585038b804372505cc0d694f9',
          5: '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf32ea0c3387e2221c3a15e5c13d3e794733a3f26e33dedd9d17bfdcd0dd0995cebf764a06f8c631c9bc39101ba3c3de91e47c69097c4f73fe43615eed4dd0bf6d8aa094f',
          10: '0xf8a58085012a05f200830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf337a0260a8b91b226d37d757a9a38b39f6ccf497a5f614a0c85a3b2f4d689ca716aa8a06093d8281e605dd3673d33e8bbb702f0d997b4a1d180702d7546c6e5e59db955',
          25: '0xf8a68086048c27395000830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf356a0c773dd1d7a49015fcc6127e25cf7fec4b5c9e36c695fd43bf9cd08f549b0401ba02355ffe43d2fb8334953022dc660157fb1293c24e39a907faf2e0863f8ddf030',
          42: '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf378a0e36a8e36e27e1be681ad2ad5192ad11bff1662d709da3b0c199585c9da88663ba030164d1bed114c91393ecdfb5d8a29f10cee48612b0cb677b43d815a8f55d646',
          56: '0xf8a68085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf38193a0531f6ac702a2e2df6b5b450e7d42a1300d0946c9adfc8e3bdcd92a6a3c423d58a069cb351294648c7ce633d6d68edb0539573fafa416fe1dcc399d8f37478e2cb3',
          66: '0xf8a68085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf381a8a0ddcef11864975516686b6c55ff627fa9b541e54a192318c89c72a947baaa6411a01fddd1917ae93b56870fbb9750bd0c7d4f1ade61ea4bc9f2696fdc7fe3ba75e4',
          69: '0xf8a68085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf381aea04c2f95d617187c2f3aaf2e01567b18e4d3ef6aa9368a2e6a2f1bedfc19e90064a003676cd9694dd1d96d2b3a33479291c77a2b85c9733c0bfca8cccefbb70b6f58',
          97: '0xf8a68085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf381e6a0f18aa33574b3f550cdacb70df4f5a2e321fa866085b25c15950d7275c2f3948ea06d7eb4cc1f4938f96db09e1c7c935f13acfcb509541671d66ef3efdcda25916d',
          100: '0xf8a68085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf381eca0bf51651c6019d8572fe921ef406c8d2cb86659c4bee764b4b3484c72d9cd98e0a03a9df2ed21116639884a540437774466e262b64dbccb3e8b870c0fb1eb054220',
          122: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820118a0ab189142c24a1de57b06c467b6d05ace53b3a725f8da3f6cd0769925e7eca815a02733b7f0ceee32fae5bd7ebbcc48df9f81c840aec90ab496514ede45773880c7',
          128: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820123a094a9d23ae349c2127a4f1a6468d56b53e2983ce8e58d77a400a54b221c7fb858a026112d7477b0a8f9da1554f8b516b9f5d7399fc55e183436aaafaeb6e23b3a27',
          137: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820136a0540c4320317a1dc7db507d5ac6c6724b087e6a6a5a3a95ff283f903acba2d0cba06aa15f091248e1a207aafcb7177838426d804a281bbc1fb42ca3ec7f2418fd87',
          250: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820217a06112925b9520e7ec9c2fadbd352ede608efd15497b021eee23f1724d49cfdcd2a05a1b29add75f1bc9d1ba056ddae0c9371fc3520a573223e8a119399aeb3006ab',
          288: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820264a0a87fbf0017a713e50c47c96dafd8efd6855737d245c45a84ac0d6bd47efc0f67a0204b4fdf55475dd5d7fc86811a416bf278e5d4a7d95781fbc11b5e4b39b91e86',
          1284: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820a2ca09ae56c29db91b123c0368681381e401fdc35e4a4d0c177d4b3ba5580816b00caa065f117e1fefb65492ae1589d051bb9dcfaa5da97851cd56ba6059c3ad78e564e',
          1285: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820a2da03092f146b7329600757704e4633aaf6e6ee149111ca0b57cff6ea2bf5e80b96aa0193957662dfd092c83315ea7b5406e5ca4bef82d4cb6588505fe4a2054f0c3a6',
          1337: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3820a95a00db349575a2d83fcd1b6173175bb1831fe36ec37d578dd830800f379ed3690c2a031fcf67ffb9cd9a159ea2f28f18f1485d93486fceef4c6ccbb4d2e13d2931152',
          9001: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3824675a05612ec4b543814d42f248173ab580f00da27e13a00e53d04167672f75986de6aa0182d7083be2056b74e953f23f08d43b3b41273c55232dc6787da85852fa9cd95',
          1088: '0xf8a78085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf38208a4a0287d7e05f4362618e0b7329b0e551deb014462903b42f1d048324914a1315538a07afe5011f3c36bc360a5f49642026e62e9228d736dfc1eb1b56aa0ed9ec2b038',
          42161:
            '0xf8a88085012a05f200830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf383014986a004ed3a4bf51398c176780944363c55122b2b9f9ed4afb53e3793eda60a4c82e1a04d3647daba62155047f8a6742c763da905731c59b90391c219f8c84a6127b002',
          42220:
            '0xf8a88085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3830149fca091845137eb1af5c368689522876b59d0c417ebf15f451c0b951c658c377ca8f8a01c5bd46a5c90caacdc520917321e0cac4b971e5efcaf8563a2fde547f34c0221',
          43113:
            '0xf8a88085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3830150f6a07b7e8c54f25da18677d2cca41357fc57d8ba365ea356c22d0a0f6a448e0b301fa03a6287c0dd3747a88e24e96c0d4d667b8c4a275d6b60a8c8d90dab6104f9c662',
          43114:
            '0xf8a88085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3830150f8a0f6f8627f4101ee602b4cb2d859d18bda34ef2a1f2a43e8dedcf31f3648cf1335a006e7824753ba1cf69dea4852a28a8a53507a3dee5e7cb3eb99a77292b82e3bcd',
          80001:
            '0xf8a88085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf383027126a08c75a0cab1f812db61d884222732aa464b8d31e90a5e49d43365919f7e4e8981a0275ce1b9fad3fe0b839df45300311a1244bd66da8af0ebac121103f0665e81e3',
          421611:
            '0xf8a80285174876e800830f42408080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3830cddf9a0da6b07091d5f325877f2ab9de0633e8e665f993136b3dfb3a1e292c11f8eac8aa07bb8277b2e8de5772fca3a5b9bb7df2883f02f9e376e3f1128f8cf4ef6de5a18',
          1313161554:
            '0xf8a98085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3849c8a82c7a0557ccbe8dc42ae191ed536ec73d415abcd87bc7f0c5316037e4f34ada9ea463fa02a0e797838cd257ab6d72fbbc8967637ff1babdb1af9efcb91f3943fe2eecda4',
          1666600000:
            '0xf8a98085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf384c6ac98a3a0cf443b6067cad98ae05eeb49f7b22ca2d55b671d7e78aa74d96c42d8a1ac908fa075f13ff3d5de50018cf167eb9ae3299f963140cbbf0843241bdb8d36d994065c',
        }

        return {
          factory: '0x2Fd525b8B2e2a69d054dCCB033a0e33E0B4AB370',
          deployer: '0x954e3EB8DE035ec1Bc8FE8FA0091D5B87AB17D47',
          funding: '10000000000000000',
          signedTx: deployments[network],
        }
      },
}

export default config
