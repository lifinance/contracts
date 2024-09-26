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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getViemChainForNetworkName = void 0;
var chains = __importStar(require("viem/chains"));
var chainNameMappings = {
    zksync: 'zkSync',
    polygonzkevm: 'polygonZkEvm',
    immutablezkevm: 'immutableZkEvm',
    xlayer: 'xLayer',
};
var chainMap = {};
for (var _i = 0, _a = Object.entries(chains); _i < _a.length; _i++) {
    var _b = _a[_i], k = _b[0], v = _b[1];
    // @ts-ignore
    chainMap[k] = v;
}
var getViemChainForNetworkName = function (networkName) {
    var chainName = chainNameMappings[networkName] || networkName;
    var chain = chainMap[chainName];
    if (!chain)
        throw new Error("Chain ".concat(networkName, " (aka '").concat(chainName, "', if a mapping exists) not supported by viem or requires name mapping. Check if you can find your chain here: https://github.com/wevm/viem/tree/main/src/chains/definitions"));
    return chain;
};
exports.getViemChainForNetworkName = getViemChainForNetworkName;
