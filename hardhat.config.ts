import 'dotenv/config'
import '@nomiclabs/hardhat-ethers'
import { HardhatUserConfig } from 'hardhat/types'
import '@typechain/hardhat'
import { node_url, accounts } from './utils/network'
import '@nomiclabs/hardhat-etherscan'

require('./tasks/generateDiamondABI.ts')

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.17',
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
  },
  paths: {
    sources: 'src',
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5',
  },
}

export default config
