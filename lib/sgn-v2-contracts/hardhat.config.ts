import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-contract-sizer';
import 'hardhat-deploy';
import 'hardhat-gas-reporter';

import * as dotenv from 'dotenv';
import { HardhatUserConfig } from 'hardhat/types';

dotenv.config();

const DEFAULT_ENDPOINT = 'http://localhost:8545';
const DEFAULT_PRIVATE_KEY =
  process.env.DEFAULT_PRIVATE_KEY || 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// Testnets
const kovanEndpoint = process.env.KOVAN_ENDPOINT || DEFAULT_ENDPOINT;
const kovanPrivateKey = process.env.KOVAN_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const ropstenEndpoint = process.env.ROPSTEN_ENDPOINT || DEFAULT_ENDPOINT;
const ropstenPrivateKey = process.env.ROPSTEN_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const goerliEndpoint = process.env.GOERLI_ENDPOINT || DEFAULT_ENDPOINT;
const goerliPrivateKey = process.env.GOERLI_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const bscTestEndpoint = process.env.BSC_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const bscTestPrivateKey = process.env.BSC_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const optimismTestEndpoint = process.env.OPTIMISM_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const optimismTestPrivateKey = process.env.OPTIMISM_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const fantomTestEndpoint = process.env.FANTOM_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const fantomTestPrivateKey = process.env.FANTOM_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const avalancheTestEndpoint = process.env.AVALANCHE_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const avalancheTestPrivateKey = process.env.AVALANCHE_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const celoAlfajoresTestEndpoint = process.env.CELO_ALFAJORES_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const celoAlfajoresTestPrivateKey = process.env.CELO_ALFAJORES_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const oasisEmeraldTestEndpoint = process.env.OASIS_EMERALD_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const oasisEmeraldTestPrivateKey = process.env.OASIS_EMERALD_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const moonbaseAlphaTestEndpoint = process.env.MOONBASE_ALPHA_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const moonbaseAlphaTestPrivateKey = process.env.MOONBASE_ALPHA_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const reiTestEndpoint = process.env.REI_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const reiTestPrivateKey = process.env.REI_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const nervosGodwokenTestEndpoint = process.env.NERVOS_GODWOKEN_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const nervosGodwokenTestPrivateKey = process.env.NERVOS_GODWOKEN_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const kavaTestEndpoint = process.env.KAVA_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const kavaTestPrivateKey = process.env.KAVA_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const darwiniaPangolinTestEndpoint = process.env.DARWINIA_PANGOLIN_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const darwiniaPangolinTestPrivateKey = process.env.DARWINIA_PANGOLIN_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const platonTestEndpoint = process.env.PLATON_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const platonTestPrivateKey = process.env.PLATON_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const polygonTestEndpoint = process.env.POLYGON_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const polygonTestPrivateKey = process.env.POLYGON_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const sxTestEndpoint = process.env.SX_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const sxTestPrivateKey = process.env.SX_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const swimmerTestEndpoint = process.env.SWIMMER_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const swimmerTestPrivateKey = process.env.SWIMMER_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const dexalotTestEndpoint = process.env.DEXALOT_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const dexalotTestPrivateKey = process.env.DEXALOT_TEST_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const nervosTestnetEndpoint = process.env.NERVOS_TESTNET_ENDPOINT || DEFAULT_ENDPOINT;
const nervosTestnetPrivateKey = process.env.NERVOS_TESTNET_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const shibuyaTestnetEndpoint = process.env.SHIBUYA_TESTNET_ENDPOINT || DEFAULT_ENDPOINT;
const shibuyaTestnetPrivateKey = process.env.SHIBUYA_TESTNET_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const cubeDevnetEndpoint = process.env.CUBE_DEVNET_ENDPOINT || DEFAULT_ENDPOINT;
const cubeDevnetPrivateKey = process.env.CUBE_DEVNET_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

// Mainnets
const ethMainnetEndpoint = process.env.ETH_MAINNET_ENDPOINT || DEFAULT_ENDPOINT;
const ethMainnetPrivateKey = process.env.ETH_MAINNET_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const bscEndpoint = process.env.BSC_ENDPOINT || DEFAULT_ENDPOINT;
const bscPrivateKey = process.env.BSC_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const arbitrumEndpoint = process.env.ARBITRUM_ENDPOINT || DEFAULT_ENDPOINT;
const arbitrumPrivateKey = process.env.ARBITRUM_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const arbitrumNovaEndpoint = process.env.ARBITRUM_NOVA_ENDPOINT || DEFAULT_ENDPOINT;
const arbitrumNovaPrivateKey = process.env.ARBITRUM_NOVA_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const polygonEndpoint = process.env.POLYGON_ENDPOINT || DEFAULT_ENDPOINT;
const polygonPrivateKey = process.env.POLYGON_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const fantomEndpoint = process.env.FANTOM_ENDPOINT || DEFAULT_ENDPOINT;
const fantomPrivateKey = process.env.FANTOM_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const avalancheEndpoint = process.env.AVALANCHE_ENDPOINT || DEFAULT_ENDPOINT;
const avalanchePrivateKey = process.env.AVALANCHE_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const optimismEndpoint = process.env.OPTIMISM_ENDPOINT || DEFAULT_ENDPOINT;
const optimismPrivateKey = process.env.OPTIMISM_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const bobaEndpoint = process.env.BOBA_ENDPOINT || DEFAULT_ENDPOINT;
const bobaPrivateKey = process.env.BOBA_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const harmonyEndpoint = process.env.HARMONY_ENDPOINT || DEFAULT_ENDPOINT;
const harmonyPrivateKey = process.env.HARMONY_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const moonbeamEndpoint = process.env.MOONBEAM_ENDPOINT || DEFAULT_ENDPOINT;
const moonbeamPrivateKey = process.env.MOONBEAM_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const moonriverEndpoint = process.env.MOONRIVER_ENDPOINT || DEFAULT_ENDPOINT;
const moonriverPrivateKey = process.env.MOONRIVER_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const celoEndpoint = process.env.CELO_ENDPOINT || DEFAULT_ENDPOINT;
const celoPrivateKey = process.env.CELO_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const oasisEmeraldEndpoint = process.env.OASIS_EMERALD_ENDPOINT || DEFAULT_ENDPOINT;
const oasisEmeraldPrivateKey = process.env.OASIS_EMERALD_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const metisEndpoint = process.env.METIS_ENDPOINT || DEFAULT_ENDPOINT;
const metisPrivateKey = process.env.METIS_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const auroraEndpoint = process.env.AURORA_ENDPOINT || DEFAULT_ENDPOINT;
const auroraPrivateKey = process.env.AURORA_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const xdaiEndpoint = process.env.XDAI_ENDPOINT || DEFAULT_ENDPOINT;
const xdaiPrivateKey = process.env.XDAI_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const oecEndpoint = process.env.OEC_ENDPOINT || DEFAULT_ENDPOINT;
const oecPrivateKey = process.env.OEC_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const hecoEndpoint = process.env.HECO_ENDPOINT || DEFAULT_ENDPOINT;
const hecoPrivateKey = process.env.HECO_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const astarEndpoint = process.env.ASTAR_ENDPOINT || DEFAULT_ENDPOINT;
const astarPrivateKey = process.env.ASTAR_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const shidenEndpoint = process.env.SHIDEN_ENDPOINT || DEFAULT_ENDPOINT;
const shidenPrivateKey = process.env.SHIDEN_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const syscoinEndpoint = process.env.SYSCOIN_ENDPOINT || DEFAULT_ENDPOINT;
const syscoinPrivateKey = process.env.SYSCOIN_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const milkomedaEndpoint = process.env.MILKOMEDA_ENDPOINT || DEFAULT_ENDPOINT;
const milkomedaPrivateKey = process.env.MILKOMEDA_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const evmosEndpoint = process.env.EVMOS_ENDPOINT || DEFAULT_ENDPOINT;
const evmosPrivateKey = process.env.EVMOS_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const cloverEndpoint = process.env.CLOVER_ENDPOINT || DEFAULT_ENDPOINT;
const cloverPrivateKey = process.env.CLOVER_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const reiEndpoint = process.env.REI_ENDPOINT || DEFAULT_ENDPOINT;
const reiPrivateKey = process.env.REI_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const confluxEndpoint = process.env.CONFLUX_ENDPOINT || DEFAULT_ENDPOINT;
const confluxPrivateKey = process.env.CONFLUX_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const darwiniaCrabEndpoint = process.env.DARWINIA_CRAB_ENDPOINT || DEFAULT_ENDPOINT;
const darwiniaCrabPrivateKey = process.env.DARWINIA_CRAB_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const platonEndpoint = process.env.PLATON_ENDPOINT || DEFAULT_ENDPOINT;
const platonPrivateKey = process.env.PLATON_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const ontologyEndpoint = process.env.ONTOLOGY_ENDPOINT || DEFAULT_ENDPOINT;
const ontologyPrivateKey = process.env.ONTOLOGY_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const swimmerEndpoint = process.env.SWIMMER_ENDPOINT || DEFAULT_ENDPOINT;
const swimmerPrivateKey = process.env.SWIMMER_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const sxNetworkEndpoint = process.env.SX_NETWORK_ENDPOINT || DEFAULT_ENDPOINT;
const sxNetworkPrivateKey = process.env.SX_NETWORK_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const apeEndpoint = process.env.APE_ENDPOINT || DEFAULT_ENDPOINT;
const apePrivateKey = process.env.APE_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const kavaEndpoint = process.env.KAVA_ENDPOINT || DEFAULT_ENDPOINT;
const kavaPrivateKey = process.env.KAVA_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const nervosGodwokenEndpoint = process.env.NERVOS_GODWOKEN_ENDPOINT || DEFAULT_ENDPOINT;
const nervosGodwokenPrivateKey = process.env.NERVOS_GODWOKEN_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const klaytnEndpoint = process.env.KLAYTN_ENDPOINT || DEFAULT_ENDPOINT;
const klaytnPrivateKey = process.env.KLAYTN_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    // Testnets
    hardhat: {},
    localhost: { timeout: 600000 },
    kovan: {
      url: kovanEndpoint,
      accounts: [`0x${kovanPrivateKey}`]
    },
    ropsten: {
      url: ropstenEndpoint,
      accounts: [`0x${ropstenPrivateKey}`]
    },
    goerli: {
      url: goerliEndpoint,
      accounts: [`0x${goerliPrivateKey}`]
    },
    bscTest: {
      url: bscTestEndpoint,
      accounts: [`0x${bscTestPrivateKey}`]
    },
    fantomTest: {
      url: fantomTestEndpoint,
      accounts: [`0x${fantomTestPrivateKey}`]
    },
    optimismTest: {
      url: optimismTestEndpoint,
      accounts: [`0x${optimismTestPrivateKey}`]
    },
    avalancheTest: {
      url: avalancheTestEndpoint,
      accounts: [`0x${avalancheTestPrivateKey}`]
    },
    celoAlfajoresTest: {
      url: celoAlfajoresTestEndpoint,
      accounts: [`0x${celoAlfajoresTestPrivateKey}`]
    },
    oasisEmeraldTest: {
      url: oasisEmeraldTestEndpoint,
      accounts: [`0x${oasisEmeraldTestPrivateKey}`]
    },
    moonbaseAlphaTest: {
      url: moonbaseAlphaTestEndpoint,
      accounts: [`0x${moonbaseAlphaTestPrivateKey}`]
    },
    reiTest: {
      url: reiTestEndpoint,
      accounts: [`0x${reiTestPrivateKey}`]
    },
    nervosGodwokenTest: {
      url: nervosGodwokenTestEndpoint,
      accounts: [`0x${nervosGodwokenTestPrivateKey}`]
    },
    kavaTest: {
      url: kavaTestEndpoint,
      accounts: [`0x${kavaTestPrivateKey}`]
    },
    darwiniaPangolinTest: {
      url: darwiniaPangolinTestEndpoint,
      accounts: [`0x${darwiniaPangolinTestPrivateKey}`]
    },
    platonTest: {
      url: platonTestEndpoint,
      accounts: [`0x${platonTestPrivateKey}`]
    },
    polygonTest: {
      url: polygonTestEndpoint,
      accounts: [`0x${polygonTestPrivateKey}`]
    },
    sxTest: {
      url: sxTestEndpoint,
      accounts: [`0x${sxTestPrivateKey}`]
    },
    swimmerTest: {
      url: swimmerTestEndpoint,
      accounts: [`0x${swimmerTestPrivateKey}`]
    },
    dexalotTest: {
      url: dexalotTestEndpoint,
      accounts: [`0x${dexalotTestPrivateKey}`]
    },
    nervosTestnet: {
      url: nervosTestnetEndpoint,
      accounts: [`0x${nervosTestnetPrivateKey}`]
    },
    shibuyaTestnet: {
      url: shibuyaTestnetEndpoint,
      accounts: [`0x${shibuyaTestnetPrivateKey}`]
    },
    cubeDevnet: {
      url: cubeDevnetEndpoint,
      accounts: [`0x${cubeDevnetPrivateKey}`]
    },
    // Mainnets
    ethMainnet: {
      url: ethMainnetEndpoint,
      accounts: [`0x${ethMainnetPrivateKey}`]
    },
    bsc: {
      url: bscEndpoint,
      accounts: [`0x${bscPrivateKey}`]
    },
    arbitrum: {
      url: arbitrumEndpoint,
      accounts: [`0x${arbitrumPrivateKey}`]
    },
    arbitrumNova: {
      url: arbitrumNovaEndpoint,
      accounts: [`0x${arbitrumNovaPrivateKey}`]
    },
    polygon: {
      url: polygonEndpoint,
      accounts: [`0x${polygonPrivateKey}`],
      gasPrice: 50000000000
    },
    fantom: {
      url: fantomEndpoint,
      accounts: [`0x${fantomPrivateKey}`]
    },
    avalanche: {
      url: avalancheEndpoint,
      accounts: [`0x${avalanchePrivateKey}`]
    },
    optimism: {
      url: optimismEndpoint,
      accounts: [`0x${optimismPrivateKey}`]
    },
    boba: {
      url: bobaEndpoint,
      accounts: [`0x${bobaPrivateKey}`]
    },
    harmony: {
      url: harmonyEndpoint,
      accounts: [`0x${harmonyPrivateKey}`]
    },
    moonbeam: {
      url: moonbeamEndpoint,
      accounts: [`0x${moonbeamPrivateKey}`]
    },
    moonriver: {
      url: moonriverEndpoint,
      accounts: [`0x${moonriverPrivateKey}`]
    },
    celo: {
      url: celoEndpoint,
      accounts: [`0x${celoPrivateKey}`]
    },
    oasisEmerald: {
      url: oasisEmeraldEndpoint,
      accounts: [`0x${oasisEmeraldPrivateKey}`]
    },
    metis: {
      url: metisEndpoint,
      accounts: [`0x${metisPrivateKey}`]
    },
    aurora: {
      url: auroraEndpoint,
      accounts: [`0x${auroraPrivateKey}`]
    },
    xdai: {
      url: xdaiEndpoint,
      accounts: [`0x${xdaiPrivateKey}`]
    },
    oec: {
      url: oecEndpoint,
      accounts: [`0x${oecPrivateKey}`]
    },
    heco: {
      url: hecoEndpoint,
      accounts: [`0x${hecoPrivateKey}`]
    },
    astar: {
      url: astarEndpoint,
      accounts: [`0x${astarPrivateKey}`]
    },
    shiden: {
      url: shidenEndpoint,
      accounts: [`0x${shidenPrivateKey}`]
    },
    syscoin: {
      url: syscoinEndpoint,
      accounts: [`0x${syscoinPrivateKey}`]
    },
    milkomeda: {
      url: milkomedaEndpoint,
      accounts: [`0x${milkomedaPrivateKey}`]
    },
    evmos: {
      url: evmosEndpoint,
      accounts: [`0x${evmosPrivateKey}`]
    },
    clover: {
      url: cloverEndpoint,
      accounts: [`0x${cloverPrivateKey}`]
    },
    rei: {
      url: reiEndpoint,
      accounts: [`0x${reiPrivateKey}`]
    },
    conflux: {
      url: confluxEndpoint,
      accounts: [`0x${confluxPrivateKey}`]
    },
    darwiniaCrab: {
      url: darwiniaCrabEndpoint,
      accounts: [`0x${darwiniaCrabPrivateKey}`]
    },
    platon: {
      url: platonEndpoint,
      accounts: [`0x${platonPrivateKey}`]
    },
    ontology: {
      url: ontologyEndpoint,
      accounts: [`0x${ontologyPrivateKey}`]
    },
    swimmer: {
      url: swimmerEndpoint,
      accounts: [`0x${swimmerPrivateKey}`]
    },
    sxNetwork: {
      url: sxNetworkEndpoint,
      accounts: [`0x${sxNetworkPrivateKey}`]
    },
    ape: {
      url: apeEndpoint,
      accounts: [`0x${apePrivateKey}`]
    },
    kava: {
      url: kavaEndpoint,
      accounts: [`0x${kavaPrivateKey}`]
    },
    nervosGodwoken: {
      url: nervosGodwokenEndpoint,
      accounts: [`0x${nervosGodwokenPrivateKey}`]
    },
    klaytn: {
      url: klaytnEndpoint,
      accounts: [`0x${klaytnPrivateKey}`],
      gasPrice: 250000000000
    }
  },
  namedAccounts: {
    deployer: {
      default: 0
    }
  },
  solidity: {
    version: '0.8.9',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800
      }
    }
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true' ? true : false,
    noColors: true,
    outputFile: 'reports/gas_usage/summary.txt'
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5'
  },
  etherscan: {
    apiKey: {
      goerli: process.env.ETHERSCAN_API_KEY,
      avalancheFujiTestnet: process.env.SNOWTRACE_API_KEY,
      bscTestnet: process.env.BSCSCAN_API_KEY,
      arbitrumTestnet: process.env.ARBISCAN_API_KEY,
      ftmTestnet: process.env.FTMSCAN_API_KEY,
      polygonMumbai: process.env.POLYGONSCAN_API_KEY,

      mainnet: process.env.ETHERSCAN_API_KEY,
      avalanche: process.env.SNOWTRACE_API_KEY,
      bsc: process.env.BSCSCAN_API_KEY,
      arbitrumOne: process.env.ARBISCAN_API_KEY,
      optimisticEthereum: process.env.OPTIMISTIC_ETHERSCAN_API_KEY,
      opera: process.env.FTMSCAN_API_KEY,
      polygon: process.env.POLYGONSCAN_API_KEY,
      aurora: process.env.AURORASCAN_API_KEY,
      moonriver: process.env.MOONRIVER_MOONSCAN_API_KEY,
      moonbeam: process.env.MOONBEAM_MOONSCAN_API_KEY,
      heco: process.env.HECOSCAN_API_KEY
    }
  }
};

export default config;
