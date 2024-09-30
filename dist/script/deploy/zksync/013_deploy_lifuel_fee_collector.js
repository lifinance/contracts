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
var _9999_utils_1 = require("./9999_utils");
var global_json_1 = __importDefault(require("../config/global.json"));
var func = function (hre) {
    return __awaiter(this, void 0, void 0, function () {
        var deployments, getNamedAccounts, deploy, deployer, LIFUEL_REBALANCE_WALLET_ADDR, diamond, registryFacet, deployedLiFuelFeeCollector, lifuelFeeCollector, lifuelFeeCollectorAddr, isVerified;
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
                    LIFUEL_REBALANCE_WALLET_ADDR = global_json_1.default.lifuelRebalanceWallet;
                    return [4 /*yield*/, hardhat_1.ethers.getContract(_9999_utils_1.diamondContractName)];
                case 2:
                    diamond = _a.sent();
                    return [4 /*yield*/, hardhat_1.ethers.getContractAt('PeripheryRegistryFacet', diamond.address)];
                case 3:
                    registryFacet = (_a.sent());
                    return [4 /*yield*/, deploy('LiFuelFeeCollector', {
                            from: deployer,
                            args: [LIFUEL_REBALANCE_WALLET_ADDR],
                            log: true,
                            skipIfAlreadyDeployed: true,
                        })];
                case 4:
                    deployedLiFuelFeeCollector = _a.sent();
                    return [4 /*yield*/, hardhat_1.ethers.getContract('LiFuelFeeCollector')];
                case 5:
                    lifuelFeeCollector = _a.sent();
                    return [4 /*yield*/, registryFacet.getPeripheryContract('LiFuelFeeCollector')];
                case 6:
                    lifuelFeeCollectorAddr = _a.sent();
                    if (!(lifuelFeeCollectorAddr !== lifuelFeeCollector.address)) return [3 /*break*/, 8];
                    console.log('Updating periphery registry...');
                    return [4 /*yield*/, registryFacet.registerPeripheryContract('LiFuelFeeCollector', lifuelFeeCollector.address)];
                case 7:
                    _a.sent();
                    console.log('Done!');
                    _a.label = 8;
                case 8: return [4 /*yield*/, (0, _9999_utils_1.verifyContract)(hre, 'LiFuelFeeCollector', {
                        address: lifuelFeeCollector.address,
                        args: [LIFUEL_REBALANCE_WALLET_ADDR],
                    })];
                case 9:
                    isVerified = _a.sent();
                    return [4 /*yield*/, (0, _9999_utils_1.updateDeploymentLogs)('LiFuelFeeCollector', deployedLiFuelFeeCollector, isVerified)];
                case 10:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
};
exports.default = func;
func.id = 'deploy_lifuel_fee_collector';
func.tags = ['DeployLiFuelFeeCollector'];
// func.dependencies = ['DeployPeripheryRegistryFacet']
