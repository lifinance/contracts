"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.chainNameMappings = void 0;
var citty_1 = require("citty");
var viem_1 = require("viem");
var chains = __importStar(require("viem/chains"));
var accounts_1 = require("viem/accounts");
var viemScriptHelpers_1 = require("../../utils/viemScriptHelpers");
exports.chainNameMappings = {
    zksync: 'zkSync',
    polygonzkevm: 'polygonZkEvm',
};
var chainMap = {};
for (var _i = 0, _a = Object.entries(chains); _i < _a.length; _i++) {
    var _b = _a[_i], k = _b[0], v = _b[1];
    // @ts-ignore
    chainMap[k] = v;
}
var main = (0, citty_1.defineCommand)({
    meta: {
        name: 'diamond-sync-sigs',
        description: 'Sync approved function signatures',
    },
    args: {
        network: {
            type: 'string',
            description: 'Network name',
            required: true,
        },
        rpcUrl: {
            type: 'string',
            description: 'RPC URL',
        },
        privateKey: {
            type: 'string',
            description: 'Private key',
            required: true,
        },
        environment: {
            type: 'string',
            description: 'PROD (production) or STAGING (staging) environment',
            required: true,
        },
    },
    run: function (_a) {
        var args = _a.args;
        return __awaiter(this, void 0, void 0, function () {
            var network, privateKey, environment, chain, deployedContracts, rpcUrl, publicClient, dexManagerReader, sigs, calls, results, sigsToApprove, i, account, walletClient, tx;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        network = args.network, privateKey = args.privateKey, environment = args.environment;
                        chain = (0, viemScriptHelpers_1.getViemChainForNetworkName)(network);
                        console.log("Checking signature for ".concat(chain.name));
                        return [4 /*yield*/, Promise.resolve("".concat("../../deployments/".concat(network.toLowerCase()).concat(environment == 'staging' ? '.staging' : '', ".json"))).then(function (s) { return __importStar(require(s)); })];
                    case 1:
                        deployedContracts = _b.sent();
                        rpcUrl = args.rpcUrl || chain.rpcUrls.default.http[0];
                        publicClient = (0, viem_1.createPublicClient)({
                            batch: { multicall: true },
                            chain: chain,
                            transport: (0, viem_1.http)(rpcUrl),
                        });
                        dexManagerReader = (0, viem_1.getContract)({
                            address: deployedContracts['LiFiDiamond'],
                            abi: (0, viem_1.parseAbi)([
                                'function isFunctionApproved(bytes4) external view returns (bool)',
                            ]),
                            client: publicClient,
                        });
                        return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require("../../config/sigs.json")); })];
                    case 2:
                        sigs = (_b.sent()).sigs;
                        calls = sigs.map(function (sig) {
                            return __assign(__assign({}, dexManagerReader), { functionName: 'isFunctionApproved', args: [sig] });
                        });
                        return [4 /*yield*/, publicClient.multicall({ contracts: calls })
                            // Get list of function signatures to approve
                        ];
                    case 3:
                        results = _b.sent();
                        sigsToApprove = [];
                        for (i = 0; i < results.length; i++) {
                            if (!results[i].result) {
                                console.log('Function not approved:', sigs[i]);
                                sigsToApprove.push(sigs[i]);
                            }
                        }
                        account = (0, accounts_1.privateKeyToAccount)("0x".concat(privateKey));
                        walletClient = (0, viem_1.createWalletClient)({
                            chain: chain,
                            transport: (0, viem_1.http)(),
                            account: account,
                        });
                        if (!(sigsToApprove.length > 0)) return [3 /*break*/, 5];
                        // Approve function signatures
                        console.log('Approving function signatures...');
                        return [4 /*yield*/, walletClient.writeContract({
                                address: deployedContracts['LiFiDiamond'],
                                abi: (0, viem_1.parseAbi)([
                                    'function batchSetFunctionApprovalBySignature(bytes4[],bool) external',
                                ]),
                                functionName: 'batchSetFunctionApprovalBySignature',
                                args: [sigsToApprove, true],
                                account: account,
                            })];
                    case 4:
                        tx = _b.sent();
                        console.log('Transaction:', tx);
                        return [3 /*break*/, 6];
                    case 5:
                        console.log('All Signatures are already approved.');
                        _b.label = 6;
                    case 6: return [2 /*return*/];
                }
            });
        });
    },
});
(0, citty_1.runMain)(main);
