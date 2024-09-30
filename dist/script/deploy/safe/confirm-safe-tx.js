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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var citty_1 = require("citty");
var viem_1 = require("viem");
var protocol_kit_1 = __importStar(require("@safe-global/protocol-kit"));
var api_kit_1 = __importDefault(require("@safe-global/api-kit"));
var ethers6_1 = require("ethers6");
var consola_1 = __importDefault(require("consola"));
var chains = __importStar(require("viem/chains"));
var config_1 = require("./config");
var viemScriptHelpers_1 = require("../../utils/viemScriptHelpers");
var ABI_LOOKUP_URL = "https://api.openchain.xyz/signature-database/v1/lookup?function=%SELECTOR%&filter=true";
var allNetworks = Object.keys(config_1.safeAddresses);
// In order to skip specific networks simple comment them in
var skipNetworks = [
// 'mainnet',
// 'arbitrum',
// 'aurora',
// 'avalanche',
// 'base',
// 'blast',
// 'boba',
// 'bsc',
// 'celo',
// 'fantom',
// 'fraxtal',
// 'fuse',
// 'gnosis',
// 'gravity',
// 'immutablezkevm',
// 'linea',
// 'mantle',
// 'metis',
// 'mode',
// 'moonbeam',
// 'moonriver',
// 'optimism',
// 'polygon',
// 'polygonzkevm',
// 'rootstock',
// 'scroll',
// 'sei',
// 'zksync',
];
var defaultNetworks = allNetworks.filter(function (network) { return !skipNetworks.includes(network); });
var storedResponses = {};
BigInt.prototype.toJSON = function () {
    return this.toString();
};
var retry = function (func, retries) {
    if (retries === void 0) { retries = 3; }
    return __awaiter(void 0, void 0, void 0, function () {
        var result, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, func()];
                case 1:
                    result = _a.sent();
                    return [2 /*return*/, result];
                case 2:
                    e_1 = _a.sent();
                    if (retries > 0) {
                        consola_1.default.error('Retry after error:', e_1);
                        return [2 /*return*/, retry(func, retries - 1)];
                    }
                    throw e_1;
                case 3: return [2 /*return*/];
            }
        });
    });
};
var chainMap = {};
for (var _i = 0, _a = Object.entries(chains); _i < _a.length; _i++) {
    var _b = _a[_i], k = _b[0], v = _b[1];
    // @ts-ignore
    chainMap[k] = v;
}
var func = function (network, privateKey, rpcUrl) { return __awaiter(void 0, void 0, void 0, function () {
    var chain, config, safeService, safeAddress, parsedRpcUrl, provider, signer, signerAddress, ethAdapter, protocolKit, allTx, txs, _loop_1, _i, _a, tx;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                chain = (0, viemScriptHelpers_1.getViemChainForNetworkName)(network);
                config = {
                    chainId: BigInt(chain.id),
                    txServiceUrl: config_1.safeApiUrls[network.toLowerCase()],
                };
                safeService = new api_kit_1.default(config);
                safeAddress = config_1.safeAddresses[network.toLowerCase()];
                parsedRpcUrl = rpcUrl || chain.rpcUrls.default.http[0];
                provider = new ethers6_1.ethers.JsonRpcProvider(parsedRpcUrl);
                signer = new ethers6_1.ethers.Wallet(privateKey, provider);
                return [4 /*yield*/, signer.getAddress()];
            case 1:
                signerAddress = _c.sent();
                consola_1.default.info('Chain:', chain.name);
                consola_1.default.info('Signer:', signerAddress);
                ethAdapter = new protocol_kit_1.EthersAdapter({
                    ethers: ethers6_1.ethers,
                    signerOrProvider: signer,
                });
                return [4 /*yield*/, protocol_kit_1.default.create({
                        ethAdapter: ethAdapter,
                        safeAddress: safeAddress,
                        contractNetworks: (0, config_1.getSafeUtilityContracts)(chain.id),
                    })];
            case 2:
                protocolKit = _c.sent();
                return [4 /*yield*/, retry(function () {
                        return safeService.getPendingTransactions(safeAddress);
                    })
                    // only show transaction Signer has not confirmed yet
                ];
            case 3:
                allTx = _c.sent();
                txs = allTx.results.filter(function (tx) {
                    var _a;
                    return !((_a = tx.confirmations) === null || _a === void 0 ? void 0 : _a.some(function (confirmation) { return confirmation.owner === signerAddress; }));
                });
                if (!txs.length) {
                    consola_1.default.success('No pending transactions');
                    return [2 /*return*/];
                }
                _loop_1 = function (tx) {
                    var abi, abiInterface, decoded, selector, url, response, data, fullAbiString, storedResponse, ok, _d, action, _e, txToConfirm, signedTx_1, exec;
                    return __generator(this, function (_f) {
                        switch (_f.label) {
                            case 0:
                                abi = void 0;
                                abiInterface = void 0;
                                decoded = void 0;
                                if (!tx.data) return [3 /*break*/, 3];
                                selector = tx.data.substring(0, 10);
                                url = ABI_LOOKUP_URL.replace('%SELECTOR%', selector);
                                return [4 /*yield*/, fetch(url)];
                            case 1:
                                response = _f.sent();
                                return [4 /*yield*/, response.json()];
                            case 2:
                                data = _f.sent();
                                if (data.ok &&
                                    data.result &&
                                    data.result.function &&
                                    data.result.function[selector]) {
                                    abi = data.result.function[selector][0].name;
                                    fullAbiString = "function ".concat(abi);
                                    abiInterface = (0, viem_1.parseAbi)([fullAbiString]);
                                    decoded = (0, viem_1.decodeFunctionData)({
                                        abi: abiInterface,
                                        data: tx.data,
                                    });
                                }
                                _f.label = 3;
                            case 3:
                                consola_1.default.info('Method:', abi);
                                consola_1.default.info('Decoded Data:', JSON.stringify(decoded, null, 2));
                                consola_1.default.info('Nonce:', tx.nonce);
                                consola_1.default.info('To:', tx.to);
                                consola_1.default.info('Value:', tx.value);
                                consola_1.default.info('Data:', tx.data);
                                consola_1.default.info('Proposer:', tx.proposer);
                                consola_1.default.info('Safe Tx Hash:', tx.safeTxHash);
                                storedResponse = tx.data ? storedResponses[tx.data] : undefined;
                                if (!storedResponse) return [3 /*break*/, 4];
                                _d = true;
                                return [3 /*break*/, 6];
                            case 4: return [4 /*yield*/, consola_1.default.prompt('Confirm Transaction?', {
                                    type: 'confirm',
                                })];
                            case 5:
                                _d = _f.sent();
                                _f.label = 6;
                            case 6:
                                ok = _d;
                                if (!ok) {
                                    return [2 /*return*/, "continue"];
                                }
                                if (!(storedResponse !== null && storedResponse !== void 0)) return [3 /*break*/, 7];
                                _e = storedResponse;
                                return [3 /*break*/, 9];
                            case 7: return [4 /*yield*/, consola_1.default.prompt('Action', {
                                    type: 'select',
                                    options: ['Sign & Execute Later', 'Execute Now'],
                                })];
                            case 8:
                                _e = (_f.sent());
                                _f.label = 9;
                            case 9:
                                action = _e;
                                storedResponses[tx.data] = action;
                                return [4 /*yield*/, retry(function () {
                                        return safeService.getTransaction(tx.safeTxHash);
                                    })];
                            case 10:
                                txToConfirm = _f.sent();
                                if (!(action === 'Sign & Execute Later')) return [3 /*break*/, 13];
                                consola_1.default.info('Signing transaction', tx.safeTxHash);
                                return [4 /*yield*/, protocolKit.signTransaction(txToConfirm)];
                            case 11:
                                signedTx_1 = _f.sent();
                                return [4 /*yield*/, retry(function () {
                                        return safeService.confirmTransaction(tx.safeTxHash, 
                                        // @ts-ignore
                                        signedTx_1.getSignature(signerAddress).data);
                                    })];
                            case 12:
                                _f.sent();
                                consola_1.default.success('Transaction signed', tx.safeTxHash);
                                _f.label = 13;
                            case 13:
                                if (!(action === 'Execute Now')) return [3 /*break*/, 16];
                                consola_1.default.info('Executing transaction', tx.safeTxHash);
                                return [4 /*yield*/, protocolKit.executeTransaction(txToConfirm)];
                            case 14:
                                exec = _f.sent();
                                return [4 /*yield*/, ((_b = exec.transactionResponse) === null || _b === void 0 ? void 0 : _b.wait())];
                            case 15:
                                _f.sent();
                                consola_1.default.success('Transaction executed', tx.safeTxHash);
                                _f.label = 16;
                            case 16: return [2 /*return*/];
                        }
                    });
                };
                _i = 0, _a = txs.sort(function (a, b) {
                    if (a.nonce < b.nonce)
                        return -1;
                    if (a.nonce > b.nonce)
                        return 1;
                    return 0;
                });
                _c.label = 4;
            case 4:
                if (!(_i < _a.length)) return [3 /*break*/, 7];
                tx = _a[_i];
                return [5 /*yield**/, _loop_1(tx)];
            case 5:
                _c.sent();
                _c.label = 6;
            case 6:
                _i++;
                return [3 /*break*/, 4];
            case 7: return [2 /*return*/];
        }
    });
}); };
var main = (0, citty_1.defineCommand)({
    meta: {
        name: 'propose-to-safe',
        description: 'Propose a transaction to a Gnosis Safe',
    },
    args: {
        network: {
            type: 'string',
            description: 'Network name',
        },
        rpcUrl: {
            type: 'string',
            description: 'RPC URL',
        },
        privateKey: {
            type: 'string',
            description: 'Private key of the signer',
            required: true,
        },
    },
    run: function (_a) {
        var args = _a.args;
        return __awaiter(this, void 0, void 0, function () {
            var networks, _i, networks_1, network;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        networks = args.network ? [args.network] : defaultNetworks;
                        _i = 0, networks_1 = networks;
                        _b.label = 1;
                    case 1:
                        if (!(_i < networks_1.length)) return [3 /*break*/, 4];
                        network = networks_1[_i];
                        return [4 /*yield*/, func(network, args.privateKey, args.rpcUrl)];
                    case 2:
                        _b.sent();
                        _b.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/];
                }
            });
        });
    },
});
(0, citty_1.runMain)(main);
