"use strict";
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
var hardhat_1 = require("hardhat");
var diamond_1 = require("../../utils/diamond");
var _9999_utils_1 = require("./9999_utils");
var dexs_json_1 = __importDefault(require("../../../config/dexs.json"));
var sigs_json_1 = __importDefault(require("../../../config/sigs.json"));
var func = function (hre) {
    return __awaiter(this, void 0, void 0, function () {
        var deployments, getNamedAccounts, deploy, deployer, deployedDexManagerFacet, dexManagerFacet, diamond, dexs, dexMgr_1, approvedDexs_1, notApprovedDexs, tx, sigs, isSigApproved_1, notApprovedSigs, tx, isVerified;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    // Protect against unwanted redeployments
                    if (hardhat_1.network.name !== 'zksync' && hardhat_1.network.name !== 'zksyncGoerli') {
                        return [2 /*return*/];
                    }
                    deployments = hre.deployments, getNamedAccounts = hre.getNamedAccounts;
                    deploy = deployments.deploy;
                    return [4 /*yield*/, getNamedAccounts()];
                case 1:
                    deployer = (_a.sent()).deployer;
                    return [4 /*yield*/, deploy('DexManagerFacet', {
                            from: deployer,
                            log: true,
                            skipIfAlreadyDeployed: true,
                        })];
                case 2:
                    deployedDexManagerFacet = _a.sent();
                    return [4 /*yield*/, hardhat_1.ethers.getContract('DexManagerFacet')];
                case 3:
                    dexManagerFacet = _a.sent();
                    return [4 /*yield*/, hardhat_1.ethers.getContract(_9999_utils_1.diamondContractName)];
                case 4:
                    diamond = _a.sent();
                    return [4 /*yield*/, (0, diamond_1.addOrReplaceFacets)([dexManagerFacet], diamond.address)];
                case 5:
                    _a.sent();
                    dexs = dexs_json_1.default[hardhat_1.network.name].map(function (d) {
                        return d.toLowerCase();
                    });
                    if (!(dexs && dexs.length)) return [3 /*break*/, 17];
                    console.log('Checking DEXs whitelist...');
                    return [4 /*yield*/, hardhat_1.ethers.getContractAt('DexManagerFacet', diamond.address)];
                case 6:
                    dexMgr_1 = (_a.sent());
                    return [4 /*yield*/, dexMgr_1.approvedDexs()];
                case 7:
                    approvedDexs_1 = (_a.sent()).map(function (d) {
                        return d.toLowerCase();
                    });
                    notApprovedDexs = dexs.filter(function (dex) { return !approvedDexs_1.includes(dex); });
                    if (!(notApprovedDexs.length > 0)) return [3 /*break*/, 10];
                    console.log('Updating DEX whitelist...');
                    return [4 /*yield*/, dexMgr_1.batchAddDex(notApprovedDexs)];
                case 8:
                    tx = _a.sent();
                    return [4 /*yield*/, tx.wait()];
                case 9:
                    _a.sent();
                    return [3 /*break*/, 11];
                case 10:
                    console.log('DEXs already whitelisted.');
                    _a.label = 11;
                case 11:
                    // Approve function signatures
                    console.log('Checking DEXs signatures whitelist...');
                    sigs = sigs_json_1.default.sigs;
                    return [4 /*yield*/, Promise.all(sigs.map(function (sig) {
                            return dexMgr_1.isFunctionApproved(sig);
                        }))];
                case 12:
                    isSigApproved_1 = _a.sent();
                    notApprovedSigs = sigs.filter(function (_, index) { return !isSigApproved_1[index]; });
                    if (!(notApprovedSigs.length > 0)) return [3 /*break*/, 15];
                    console.log('Updating DEX signatures...');
                    return [4 /*yield*/, dexMgr_1.batchSetFunctionApprovalBySignature(notApprovedSigs, true)];
                case 13:
                    tx = _a.sent();
                    return [4 /*yield*/, tx.wait()];
                case 14:
                    _a.sent();
                    return [3 /*break*/, 16];
                case 15:
                    console.log('DEX signatures already whitelisted.');
                    _a.label = 16;
                case 16:
                    console.log('Done!');
                    _a.label = 17;
                case 17: return [4 /*yield*/, (0, _9999_utils_1.verifyContract)(hre, 'DexManagerFacet', {
                        address: dexManagerFacet.address,
                    })];
                case 18:
                    isVerified = _a.sent();
                    return [4 /*yield*/, (0, _9999_utils_1.updateDeploymentLogs)('DexManagerFacet', deployedDexManagerFacet, isVerified)];
                case 19:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
};
exports.default = func;
func.id = 'deploy_dex_manager_facet';
func.tags = ['DeployDexManagerFacet'];
func.dependencies = ['InitialFacets', _9999_utils_1.diamondContractName, 'InitFacets'];
