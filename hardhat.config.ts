import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import '@matterlabs/hardhat-zksync-solc'
import '@matterlabs/hardhat-zksync-deploy'
import '@matterlabs/hardhat-zksync-verify'
import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-etherscan'
import '@typechain/hardhat'
import 'hardhat-deploy'
import 'hardhat-preprocessor'
import { node_url, accounts } from './script/utils/network'
import { HardhatUserConfig } from 'hardhat/types'

require('./tasks/generateDiamondABI.ts')

const PKEY = process.env.PRIVATE_KEY_PRODUCTION || null

function getRemappings() {
  return fs
    .readFileSync('remappings.txt', 'utf8')
    .split('\n')
    .filter(Boolean) // remove empty lines
    .map((line) => line.trim().split('='))
}

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
  zksolc: {
    version: '1.3.5',
    compilerSource: 'binary',
    settings: {},
  },
  namedAccounts: {
    deployer: 0,
    simpleERC20Beneficiary: 1,
  },
  networks: {
    zksync: {
      deploy: ['script/deploy/zksync'],
      url: node_url('zksync'),
      accounts: PKEY ? [PKEY] : accounts(),
      chainId: 324,
      zksync: true,
      ethNetwork: 'mainnet',
      verifyURL:
        'https://zksync2-mainnet-explorer.zksync.io/contract_verification',
    },
  },
  preprocess: {
    eachLine: (hre) => ({
      transform: (line: string, sourceInfo: { absolutePath: string }) => {
        if (line.match(/^\s*import /i)) {
          for (const [from, to] of getRemappings()) {
            if (line.includes(from) && !to.includes('node_modules')) {
              line = line.replace(
                from,
                `${path
                  .relative(sourceInfo.absolutePath, __dirname)
                  .slice(0, -2)}${to}`
              )
              break
            }
          }
        }
        return line
      },
    }),
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
