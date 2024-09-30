"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
var fs_1 = __importDefault(require("fs"));
var path_1 = __importDefault(require("path"));
require("@matterlabs/hardhat-zksync-solc");
require("@matterlabs/hardhat-zksync-deploy");
require("@matterlabs/hardhat-zksync-verify");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("@typechain/hardhat");
require("hardhat-deploy");
require("hardhat-preprocessor");
var network_1 = require("./script/utils/network");
require('./tasks/generateDiamondABI.ts');
var PKEY = process.env.PRIVATE_KEY_PRODUCTION || null;
function getRemappings() {
    return fs_1.default
        .readFileSync('remappings.txt', 'utf8')
        .split('\n')
        .filter(Boolean) // remove empty lines
        .map(function (line) { return line.trim().split('='); });
}
var config = {
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
            url: (0, network_1.node_url)('zksync'),
            accounts: PKEY ? [PKEY] : (0, network_1.accounts)(),
            chainId: 324,
            zksync: true,
            ethNetwork: 'mainnet',
            verifyURL: 'https://zksync2-mainnet-explorer.zksync.io/contract_verification',
        },
    },
    preprocess: {
        eachLine: function (hre) { return ({
            transform: function (line, sourceInfo) {
                if (line.match(/^\s*import /i)) {
                    for (var _i = 0, _a = getRemappings(); _i < _a.length; _i++) {
                        var _b = _a[_i], from = _b[0], to = _b[1];
                        if (line.includes(from) && !to.includes('node_modules')) {
                            line = line.replace(from, "".concat(path_1.default
                                .relative(sourceInfo.absolutePath, __dirname)
                                .slice(0, -2)).concat(to));
                            break;
                        }
                    }
                }
                return line;
            },
        }); },
    },
    paths: {
        sources: 'src',
    },
    typechain: {
        outDir: 'typechain',
        target: 'ethers-v5',
    },
};
exports.default = config;
