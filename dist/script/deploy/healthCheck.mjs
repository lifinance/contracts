"use strict";
var __makeTemplateObject = (this && this.__makeTemplateObject) || function (cooked, raw) {
    if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
    return cooked;
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getViemChainForNetworkName = void 0;
// @ts-nocheck
var consola_1 = require("consola");
var zx_1 = require("zx");
var citty_1 = require("citty");
var chains = __importStar(require("viem/chains"));
var viem_1 = require("viem");
var chainNameMappings = {
    zksync: 'zkSync',
    polygonzkevm: 'polygonZkEvm',
    immutablezkevm: 'immutableZkEvm',
};
var chainMap = {};
for (var _i = 0, _a = Object.entries(chains); _i < _a.length; _i++) {
    var _b = _a[_i], k = _b[0], v = _b[1];
    // @ts-ignore
    chainMap[k] = v;
}
// TODO: remove this and import from ./utils/viemScriptHelpers.ts instead (did not work when I tried it)
var getViemChainForNetworkName = function (networkName) {
    var chainName = chainNameMappings[networkName] || networkName;
    var chain = chainMap[chainName];
    if (!chain)
        throw new Error("Chain ".concat(networkName, " (aka '").concat(chainName, "', if a mapping exists) not supported by viem or requires name mapping. Check if you can find your chain here: https://github.com/wevm/viem/tree/main/src/chains/definitions"));
    return chain;
};
exports.getViemChainForNetworkName = getViemChainForNetworkName;
var SAFE_THRESHOLD = 3;
var louperCmd = 'louper-cli';
var coreFacets = [
    'DiamondCutFacet',
    'DiamondLoupeFacet',
    'OwnershipFacet',
    'WithdrawFacet',
    'DexManagerFacet',
    'PeripheryRegistryFacet',
    'AccessManagerFacet',
    'PeripheryRegistryFacet',
    'GenericSwapFacet',
    'GenericSwapFacetV3',
    'LIFuelFacet',
    'CalldataVerificationFacet',
    'StandardizedCallFacet',
];
var corePeriphery = [
    'ERC20Proxy',
    'Executor',
    'Receiver',
    'FeeCollector',
    'LiFuelFeeCollector',
    'TokenWrapper',
];
var errors = [];
var main = (0, citty_1.defineCommand)({
    meta: {
        name: 'LIFI Diamond Health Check',
        description: 'Check that the diamond is configured correctly',
    },
    args: {
        network: {
            type: 'string',
            description: 'EVM network to check',
            required: true,
        },
    },
    run: function (_a) {
        var args = _a.args;
        return __awaiter(this, void 0, void 0, function () {
            var answer, network, deployedContracts, targetStateJson, nonCoreFacets, dexs, globalConfig, chain, publicClient, diamondDeployed, diamondAddress, _i, coreFacets_1, facet, isDeployed, _b, nonCoreFacets_1, facet, isDeployed, string, facetsResult, registeredFacets, _c, _d, facet, _e, corePeriphery_1, contract, isDeployed, peripheryRegistry, addresses, _f, corePeriphery_2, periphery, dexManager, approvedDexs, numMissing, _g, _h, dex, feeCollectors, _j, feeCollectors_1, f, withdrawWallet, rebalanceWallet, refundWallet, safeAddress, accessManager, deployerWallet, approveSigs, _k, approveSigs_1, sig, refundSigs, _l, refundSigs_1, sig, safeOwners, safeAddress, safeApiUrl, configUrl, res, safeConfig, o, safeOwner;
            return __generator(this, function (_m) {
                switch (_m.label) {
                    case 0: return [4 /*yield*/, (0, zx_1.$)(templateObject_1 || (templateObject_1 = __makeTemplateObject(["", ""], ["", ""])), louperCmd).exitCode];
                    case 1:
                        if (!((_m.sent()) !== 0)) return [3 /*break*/, 5];
                        return [4 /*yield*/, consola_1.consola.prompt('Louper CLI is required but not installed. Would you like to install it now?', {
                                type: 'confirm',
                            })];
                    case 2:
                        answer = _m.sent();
                        if (!answer) return [3 /*break*/, 4];
                        return [4 /*yield*/, (0, zx_1.spinner)('Installing...', function () { return (0, zx_1.$)(templateObject_2 || (templateObject_2 = __makeTemplateObject(["npm install -g @mark3labs/louper-cli"], ["npm install -g @mark3labs/louper-cli"]))); })];
                    case 3:
                        _m.sent();
                        return [3 /*break*/, 5];
                    case 4:
                        consola_1.consola.error('Louper CLI is required to run this script');
                        process.exit(1);
                        _m.label = 5;
                    case 5:
                        network = args.network;
                        return [4 /*yield*/, Promise.resolve("".concat("../../deployments/".concat(network.toLowerCase(), ".json"))).then(function (s) { return __importStar(require(s)); })];
                    case 6:
                        deployedContracts = _m.sent();
                        return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require("../../script/deploy/_targetState.json")); })];
                    case 7:
                        targetStateJson = _m.sent();
                        nonCoreFacets = Object.keys(targetStateJson[network.toLowerCase()].production.LiFiDiamond).filter(function (k) {
                            return (!coreFacets.includes(k) &&
                                !corePeriphery.includes(k) &&
                                k !== 'LiFiDiamond' &&
                                k.endsWith('Facet'));
                        });
                        return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require("../../config/dexs.json")); })];
                    case 8:
                        dexs = (_m.sent())[network.toLowerCase()];
                        return [4 /*yield*/, Promise.resolve().then(function () { return __importStar(require('../../config/global.json')); })];
                    case 9:
                        globalConfig = _m.sent();
                        chain = (0, exports.getViemChainForNetworkName)(network);
                        publicClient = (0, viem_1.createPublicClient)({
                            batch: { multicall: true },
                            chain: chain,
                            transport: (0, viem_1.http)(),
                        });
                        consola_1.consola.info('Running post deployment checks...\n');
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │                Check Diamond Contract                   │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking diamond Contract...');
                        return [4 /*yield*/, checkIsDeployed('LiFiDiamond', deployedContracts, publicClient)];
                    case 10:
                        diamondDeployed = _m.sent();
                        if (!diamondDeployed) {
                            logError("LiFiDiamond not deployed");
                            finish();
                        }
                        else {
                            consola_1.consola.success('LiFiDiamond deployed');
                        }
                        diamondAddress = deployedContracts['LiFiDiamond'];
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │                    Check core facets                    │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking Core Facets...');
                        _i = 0, coreFacets_1 = coreFacets;
                        _m.label = 11;
                    case 11:
                        if (!(_i < coreFacets_1.length)) return [3 /*break*/, 14];
                        facet = coreFacets_1[_i];
                        return [4 /*yield*/, checkIsDeployed(facet, deployedContracts, publicClient)];
                    case 12:
                        isDeployed = _m.sent();
                        if (!isDeployed) {
                            logError("Facet ".concat(facet, " not deployed"));
                            return [3 /*break*/, 13];
                        }
                        consola_1.consola.success("Facet ".concat(facet, " deployed"));
                        _m.label = 13;
                    case 13:
                        _i++;
                        return [3 /*break*/, 11];
                    case 14:
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │         Check that non core facets are deployed         │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking Non-Core facets...');
                        _b = 0, nonCoreFacets_1 = nonCoreFacets;
                        _m.label = 15;
                    case 15:
                        if (!(_b < nonCoreFacets_1.length)) return [3 /*break*/, 18];
                        facet = nonCoreFacets_1[_b];
                        return [4 /*yield*/, checkIsDeployed(facet, deployedContracts, publicClient)];
                    case 16:
                        isDeployed = _m.sent();
                        if (!isDeployed) {
                            logError("Facet ".concat(facet, " not deployed"));
                            return [3 /*break*/, 17];
                        }
                        consola_1.consola.success("Facet ".concat(facet, " deployed"));
                        _m.label = 17;
                    case 17:
                        _b++;
                        return [3 /*break*/, 15];
                    case 18:
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │          Check that all facets are registered           │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking facets registered in diamond...');
                        zx_1.$.quiet = true;
                        string = "".concat(louperCmd, " inspect diamond -a ").concat(diamondAddress, " -n ").concat(network, " --json");
                        console.log("string: ".concat(string));
                        return [4 /*yield*/, (0, zx_1.$)(templateObject_3 || (templateObject_3 = __makeTemplateObject(["", " inspect diamond -a ", " -n ", " --json"], ["", " inspect diamond -a ", " -n ", " --json"])), louperCmd, diamondAddress, network)];
                    case 19:
                        facetsResult = _m.sent();
                        registeredFacets = JSON.parse(facetsResult.stdout).facets.map(function (f) { return f.name; });
                        for (_c = 0, _d = __spreadArray(__spreadArray([], coreFacets, true), nonCoreFacets, true); _c < _d.length; _c++) {
                            facet = _d[_c];
                            if (!registeredFacets.includes(facet)) {
                                logError("Facet ".concat(facet, " not registered in Diamond or possibly unverified"));
                            }
                            else {
                                consola_1.consola.success("Facet ".concat(facet, " registered in Diamond"));
                            }
                        }
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │      Check that core periphery facets are deployed      │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking periphery contracts...');
                        _e = 0, corePeriphery_1 = corePeriphery;
                        _m.label = 20;
                    case 20:
                        if (!(_e < corePeriphery_1.length)) return [3 /*break*/, 23];
                        contract = corePeriphery_1[_e];
                        return [4 /*yield*/, checkIsDeployed(contract, deployedContracts, publicClient)];
                    case 21:
                        isDeployed = _m.sent();
                        if (!isDeployed) {
                            logError("Periphery contract ".concat(contract, " not deployed"));
                            return [3 /*break*/, 22];
                        }
                        consola_1.consola.success("Periphery contract ".concat(contract, " deployed"));
                        _m.label = 22;
                    case 22:
                        _e++;
                        return [3 /*break*/, 20];
                    case 23:
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │          Check registered periphery contracts           │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking periphery contracts registered in diamond...');
                        peripheryRegistry = (0, viem_1.getContract)({
                            address: deployedContracts['LiFiDiamond'],
                            abi: (0, viem_1.parseAbi)([
                                'function getPeripheryContract(string) external view returns (address)',
                            ]),
                            client: publicClient,
                        });
                        return [4 /*yield*/, Promise.all(corePeriphery.map(function (c) {
                                return peripheryRegistry.read.getPeripheryContract([c]);
                            }))];
                    case 24:
                        addresses = _m.sent();
                        for (_f = 0, corePeriphery_2 = corePeriphery; _f < corePeriphery_2.length; _f++) {
                            periphery = corePeriphery_2[_f];
                            if (!addresses.includes((0, viem_1.getAddress)(deployedContracts[periphery]))) {
                                logError("Periphery contract ".concat(periphery, " not registered in Diamond"));
                            }
                            else {
                                consola_1.consola.success("Periphery contract ".concat(periphery, " registered in Diamond"));
                            }
                        }
                        if (!dexs) return [3 /*break*/, 43];
                        consola_1.consola.box('Checking DEXs approved in diamond...');
                        dexManager = (0, viem_1.getContract)({
                            address: deployedContracts['LiFiDiamond'],
                            abi: (0, viem_1.parseAbi)([
                                'function approvedDexs() external view returns (address[])',
                            ]),
                            client: publicClient,
                        });
                        return [4 /*yield*/, dexManager.read.approvedDexs()
                            // Loop through dexs excluding the address for FeeCollector, LiFuelFeeCollector and ServiceFeeCollector and TokenWrapper
                        ];
                    case 25:
                        approvedDexs = _m.sent();
                        numMissing = 0;
                        for (_g = 0, _h = dexs.filter(function (d) { return !corePeriphery.includes((0, viem_1.getAddress)(d)); }); _g < _h.length; _g++) {
                            dex = _h[_g];
                            if (!approvedDexs.includes((0, viem_1.getAddress)(dex))) {
                                logError("Dex ".concat(dex, " not approved in Diamond"));
                                numMissing++;
                            }
                        }
                        feeCollectors = corePeriphery.filter(function (p) {
                            return p === 'FeeCollector' ||
                                p === 'LiFuelFeeCollector' ||
                                p === 'TokenWrapper';
                        });
                        for (_j = 0, feeCollectors_1 = feeCollectors; _j < feeCollectors_1.length; _j++) {
                            f = feeCollectors_1[_j];
                            if (!approvedDexs.includes((0, viem_1.getAddress)(deployedContracts[f]))) {
                                logError("Periphery contract ".concat(f, " not approved as a DEX"));
                                numMissing++;
                            }
                            else {
                                consola_1.consola.success("Periphery contract ".concat(f, " approved as a DEX"));
                            }
                        }
                        consola_1.consola.info("Found ".concat(numMissing, " missing dex").concat(numMissing === 1 ? '' : 's'));
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │                Check contract ownership                 │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking ownership...');
                        withdrawWallet = (0, viem_1.getAddress)(globalConfig.withdrawWallet);
                        rebalanceWallet = (0, viem_1.getAddress)(globalConfig.lifuelRebalanceWallet);
                        refundWallet = (0, viem_1.getAddress)(globalConfig.refundWallet);
                        if (!globalConfig.safeAddresses[network.toLowerCase()]) return [3 /*break*/, 27];
                        safeAddress = globalConfig.safeAddresses[network.toLowerCase()];
                        return [4 /*yield*/, checkOwnership('LiFiDiamond', safeAddress, deployedContracts, publicClient)];
                    case 26:
                        _m.sent();
                        _m.label = 27;
                    case 27: 
                    // FeeCollector
                    return [4 /*yield*/, checkOwnership('FeeCollector', withdrawWallet, deployedContracts, publicClient)
                        // LiFuelFeeCollector
                    ];
                    case 28:
                        // FeeCollector
                        _m.sent();
                        // LiFuelFeeCollector
                        return [4 /*yield*/, checkOwnership('LiFuelFeeCollector', rebalanceWallet, deployedContracts, publicClient)
                            // Receiver
                        ];
                    case 29:
                        // LiFuelFeeCollector
                        _m.sent();
                        // Receiver
                        return [4 /*yield*/, checkOwnership('Receiver', refundWallet, deployedContracts, publicClient)
                            //          ╭─────────────────────────────────────────────────────────╮
                            //          │                Check access permissions                 │
                            //          ╰─────────────────────────────────────────────────────────╯
                        ];
                    case 30:
                        // Receiver
                        _m.sent();
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │                Check access permissions                 │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking access permissions...');
                        accessManager = (0, viem_1.getContract)({
                            address: deployedContracts['LiFiDiamond'],
                            abi: (0, viem_1.parseAbi)([
                                'function addressCanExecuteMethod(bytes4,address) external view returns (bool)',
                            ]),
                            client: publicClient,
                        });
                        deployerWallet = (0, viem_1.getAddress)(globalConfig.deployerWallet);
                        approveSigs = globalConfig.approvedSigsForDeployerWallet;
                        _k = 0, approveSigs_1 = approveSigs;
                        _m.label = 31;
                    case 31:
                        if (!(_k < approveSigs_1.length)) return [3 /*break*/, 34];
                        sig = approveSigs_1[_k];
                        return [4 /*yield*/, accessManager.read.addressCanExecuteMethod([
                                sig.sig,
                                deployerWallet,
                            ])];
                    case 32:
                        if (!(_m.sent())) {
                            logError("Deployer wallet ".concat(deployerWallet, " cannot execute ").concat(sig.name, " (").concat(sig.sig, ")"));
                        }
                        else {
                            consola_1.consola.success("Deployer wallet ".concat(deployerWallet, " can execute ").concat(sig.name, " (").concat(sig.sig, ")"));
                        }
                        _m.label = 33;
                    case 33:
                        _k++;
                        return [3 /*break*/, 31];
                    case 34:
                        refundSigs = globalConfig.approvedSigsForRefundWallet;
                        _l = 0, refundSigs_1 = refundSigs;
                        _m.label = 35;
                    case 35:
                        if (!(_l < refundSigs_1.length)) return [3 /*break*/, 38];
                        sig = refundSigs_1[_l];
                        return [4 /*yield*/, accessManager.read.addressCanExecuteMethod([
                                sig.sig,
                                refundWallet,
                            ])];
                    case 36:
                        if (!(_m.sent())) {
                            logError("Refund wallet ".concat(refundWallet, " cannot execute ").concat(sig.name, " (").concat(sig.sig, ")"));
                        }
                        else {
                            consola_1.consola.success("Refund wallet ".concat(refundWallet, " can execute ").concat(sig.name, " (").concat(sig.sig, ")"));
                        }
                        _m.label = 37;
                    case 37:
                        _l++;
                        return [3 /*break*/, 35];
                    case 38:
                        //          ╭─────────────────────────────────────────────────────────╮
                        //          │                   SAFE Configuration                    │
                        //          ╰─────────────────────────────────────────────────────────╯
                        consola_1.consola.box('Checking SAFE configuration...');
                        if (!(!globalConfig.safeAddresses[network.toLowerCase()] ||
                            !globalConfig.safeApiUrls[network.toLowerCase()])) return [3 /*break*/, 39];
                        consola_1.consola.warn('SAFE address not configured');
                        return [3 /*break*/, 42];
                    case 39:
                        safeOwners = globalConfig.safeOwners;
                        safeAddress = globalConfig.safeAddresses[network.toLowerCase()];
                        safeApiUrl = globalConfig.safeApiUrls[network.toLowerCase()];
                        configUrl = "".concat(safeApiUrl, "/v1/safes/").concat(safeAddress);
                        return [4 /*yield*/, fetch(configUrl)];
                    case 40:
                        res = _m.sent();
                        return [4 /*yield*/, res.json()
                            // Check that each safeOwner is in safeConfig.owners
                        ];
                    case 41:
                        safeConfig = _m.sent();
                        // Check that each safeOwner is in safeConfig.owners
                        for (o in safeOwners) {
                            safeOwner = (0, viem_1.getAddress)(safeOwners[o]);
                            if (!safeConfig.owners.includes(safeOwner)) {
                                logError("SAFE owner ".concat(safeOwner, " not in SAFE configuration"));
                            }
                            else {
                                consola_1.consola.success("SAFE owner ".concat(safeOwner, " is in SAFE configuration"));
                            }
                        }
                        // Check that threshold is correct
                        if (safeConfig.threshold < SAFE_THRESHOLD) {
                            logError("SAFE signature threshold is less than ".concat(SAFE_THRESHOLD));
                        }
                        else {
                            consola_1.consola.success("SAFE signature threshold is ".concat(safeConfig.threshold));
                        }
                        _m.label = 42;
                    case 42:
                        finish();
                        return [3 /*break*/, 44];
                    case 43:
                        logError('No dexs configured');
                        _m.label = 44;
                    case 44: return [2 /*return*/];
                }
            });
        });
    },
});
var logError = function (string) {
    consola_1.consola.error(string);
    errors.push(string);
};
var getOwnableContract = function (address, client) {
    return (0, viem_1.getContract)({
        address: address,
        abi: (0, viem_1.parseAbi)(['function owner() external view returns (address)']),
        client: client,
    });
};
var checkOwnership = function (name, expectedOwner, deployedContracts, publicClient) { return __awaiter(void 0, void 0, void 0, function () {
    var contractAddress, owner;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                if (!deployedContracts[name]) return [3 /*break*/, 2];
                contractAddress = deployedContracts[name];
                return [4 /*yield*/, getOwnableContract(contractAddress, publicClient).read.owner()];
            case 1:
                owner = _a.sent();
                if ((0, viem_1.getAddress)(owner) !== (0, viem_1.getAddress)(expectedOwner)) {
                    logError("".concat(name, " owner is ").concat((0, viem_1.getAddress)(owner), ", expected ").concat((0, viem_1.getAddress)(expectedOwner)));
                }
                else {
                    consola_1.consola.success("".concat(name, " owner is correct"));
                }
                _a.label = 2;
            case 2: return [2 /*return*/];
        }
    });
}); };
var checkIsDeployed = function (contract, deployedContracts, publicClient) { return __awaiter(void 0, void 0, void 0, function () {
    var code;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                if (!deployedContracts[contract]) {
                    return [2 /*return*/, false];
                }
                return [4 /*yield*/, publicClient.getCode({
                        address: deployedContracts[contract],
                    })];
            case 1:
                code = _a.sent();
                if (code === '0x') {
                    return [2 /*return*/, false];
                }
                return [2 /*return*/, true];
        }
    });
}); };
var finish = function () {
    if (errors.length) {
        consola_1.consola.error("".concat(errors.length, " Errors found in deployment"));
    }
    else {
        consola_1.consola.success('Deployment checks passed');
    }
};
(0, citty_1.runMain)(main);
var templateObject_1, templateObject_2, templateObject_3;
