"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getViemChainForNetworkName = exports.getAllNetworks = exports.accounts = exports.getMnemonic = exports.node_url = void 0;
require("dotenv/config");
var fs = __importStar(require("fs"));
var path_1 = __importDefault(require("path"));
var chains = __importStar(require("viem/chains"));
function node_url(networkName) {
    if (networkName) {
        var uri_1 = process.env['ETH_NODE_URI_' + networkName.toUpperCase()];
        if (uri_1 && uri_1 !== '') {
            return uri_1;
        }
    }
    if (networkName === 'localhost') {
        // do not use ETH_NODE_URI
        return 'http://localhost:8545'; // [pre-commit-checker: not a secret]
    }
    var uri = process.env.ETH_NODE_URI;
    if (uri) {
        uri = uri.replace('{{networkName}}', networkName);
    }
    if (!uri || uri === '') {
        // throw new Error(`environment variable "ETH_NODE_URI" not configured `);
        return '';
    }
    if (uri.indexOf('{{') >= 0) {
        throw new Error("invalid uri or network not supported by node provider : ".concat(uri));
    }
    return uri;
}
exports.node_url = node_url;
function getMnemonic(networkName) {
    if (networkName) {
        var mnemonic_1 = process.env['MNEMONIC_' + networkName.toUpperCase()];
        if (mnemonic_1 && mnemonic_1 !== '') {
            return mnemonic_1;
        }
    }
    var mnemonic = process.env.MNEMONIC;
    if (!mnemonic || mnemonic === '') {
        return 'test test test test test test test test test test test junk';
    }
    return mnemonic;
}
exports.getMnemonic = getMnemonic;
function accounts(networkName) {
    return { mnemonic: getMnemonic(networkName) };
}
exports.accounts = accounts;
// get a list of all networks from our ./networks file
function getAllNetworks() {
    try {
        // Read file contents
        var fileContents = fs.readFileSync(path_1.default.join(__dirname, '../networks'), 'utf-8');
        // Split the contents by new lines to get an array of network names
        var networkNames = fileContents
            .split('\n')
            .map(function (name) { return name.trim(); })
            .filter(function (name) { return name !== ''; });
        return networkNames;
    }
    catch (error) {
        console.error("Error reading file: ".concat(JSON.stringify(error, null, 2)));
        return [];
    }
}
exports.getAllNetworks = getAllNetworks;
// viem chain handling
var chainNameMappings = {
    zksync: 'zkSync',
    polygonzkevm: 'polygonZkEvm',
};
var chainMap = {};
for (var _i = 0, _a = Object.entries(chains); _i < _a.length; _i++) {
    var _b = _a[_i], k = _b[0], v = _b[1];
    // @ts-ignore
    chainMap[k] = v;
}
var getViemChainForNetworkName = function (network) {
    var chainName = chainNameMappings[network] || network;
    var chain = chainMap[chainName];
    if (!chain)
        throw new Error("Viem chain not found for network ".concat(network));
    return chain;
};
exports.getViemChainForNetworkName = getViemChainForNetworkName;
