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
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyContract = exports.deployFacet = exports.getContractVersion = exports.updateLog = exports.updateDiamond = exports.updateAddress = exports.updateDeploymentLogs = exports.diamondFile = exports.addressesFile = exports.diamondContractName = exports.isProduction = exports.useDefDiamond = void 0;
var fs_1 = __importDefault(require("fs"));
var hardhat_1 = require("hardhat");
var diamond_1 = require("../../utils/diamond");
exports.useDefDiamond = ((_a = process.env.USE_DEF_DIAMOND) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== 'false';
exports.isProduction = ((_b = process.env.PRODUCTION) === null || _b === void 0 ? void 0 : _b.toLowerCase()) === 'true';
exports.diamondContractName = exports.useDefDiamond
    ? 'LiFiDiamond'
    : 'LiFiDiamondImmutable';
exports.addressesFile = exports.isProduction
    ? "deployments/".concat(hardhat_1.network.name, ".json")
    : "deployments/".concat(hardhat_1.network.name, ".staging.json");
exports.diamondFile = exports.isProduction
    ? "deployments/".concat(hardhat_1.network.name, ".diamond").concat(exports.useDefDiamond ? '' : '.immutable', ".json")
    : "deployments/".concat(hardhat_1.network.name, ".diamond").concat(exports.useDefDiamond ? '' : '.immutable', ".staging.json");
var updateDeploymentLogs = function (name, deployResult, isVerified) {
    var _a;
    return __awaiter(this, void 0, void 0, function () {
        var path, version, _b, _c, _d;
        var _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0: return [4 /*yield*/, hardhat_1.artifacts.readArtifact(name)];
                case 1:
                    path = (_f.sent()).sourceName;
                    version = (0, exports.getContractVersion)(path);
                    (0, exports.updateAddress)(name, deployResult.address);
                    (0, exports.updateDiamond)(name, deployResult.address, {
                        isPeriphery: path.includes('src/Periphery'),
                        version: version,
                    });
                    _b = exports.updateLog;
                    _c = [name, version];
                    _e = {
                        ADDRESS: deployResult.address,
                        OPTIMIZER_RUNS: '10000'
                    };
                    _d = Date.bind;
                    return [4 /*yield*/, hardhat_1.ethers.provider.getBlock(((_a = deployResult.receipt) === null || _a === void 0 ? void 0 : _a.blockNumber) || 'latest')];
                case 2:
                    _e.TIMESTAMP = new (_d.apply(Date, [void 0, (_f.sent()).timestamp * 1000]))()
                        .toISOString()
                        .replace('T', ' ')
                        .split('.')[0];
                    return [4 /*yield*/, hardhat_1.ethers.getContractFactory(name)];
                case 3:
                    _b.apply(void 0, _c.concat([(_e.CONSTRUCTOR_ARGS = (_f.sent()).interface.encodeDeploy(deployResult.args),
                            _e.VERIFIED = (isVerified || false).toString(),
                            _e)]));
                    return [2 /*return*/];
            }
        });
    });
};
exports.updateDeploymentLogs = updateDeploymentLogs;
var updateAddress = function (name, address) {
    var data = {};
    try {
        data = JSON.parse(fs_1.default.readFileSync(exports.addressesFile, 'utf8'));
    }
    catch (_a) { }
    data[name] = address;
    fs_1.default.writeFileSync(exports.addressesFile, JSON.stringify(data, null, 2));
};
exports.updateAddress = updateAddress;
var updateDiamond = function (name, address, options) {
    var data = {};
    try {
        data = JSON.parse(fs_1.default.readFileSync(exports.diamondFile, 'utf8'));
    }
    catch (_a) { }
    if (!data[exports.diamondContractName]) {
        data[exports.diamondContractName] = {
            Facets: {},
            Periphery: {},
        };
    }
    if (options.isPeriphery) {
        data[exports.diamondContractName].Periphery[name] = address;
    }
    else {
        data[exports.diamondContractName].Facets[address] = {
            Name: name,
            Version: options.version || '',
        };
    }
    fs_1.default.writeFileSync(exports.diamondFile, JSON.stringify(data, null, 2));
};
exports.updateDiamond = updateDiamond;
var updateLog = function (name, version, info) {
    var data = {};
    try {
        data = JSON.parse(fs_1.default.readFileSync('deployments/_deployments_log_file.json', 'utf8'));
    }
    catch (_a) { }
    var type = exports.isProduction ? 'production' : 'staging';
    if (!data[name]) {
        data[name] = {};
    }
    if (!data[name][hardhat_1.network.name]) {
        data[name][hardhat_1.network.name] = {};
    }
    if (!data[name][hardhat_1.network.name][type]) {
        data[name][hardhat_1.network.name][type] = {};
    }
    if (!data[name][hardhat_1.network.name][type][version]) {
        data[name][hardhat_1.network.name][type][version] = [];
    }
    data[name][hardhat_1.network.name][type][version].push(info);
    fs_1.default.writeFileSync('deployments/_deployments_log_file.json', JSON.stringify(data, null, 2));
};
exports.updateLog = updateLog;
var getContractVersion = function (path) {
    var code = fs_1.default.readFileSync(path, 'utf8');
    return code.split('@custom:version')[1].split('\n')[0].trim();
};
exports.getContractVersion = getContractVersion;
var deployFacet = function (hre, name, options) {
    return __awaiter(this, void 0, void 0, function () {
        var deployments, getNamedAccounts, deploy, deployer, deployedFacet, facet, diamond, isVerified;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (hardhat_1.network.name !== 'zksync' && hardhat_1.network.name !== 'zksyncGoerli') {
                        return [2 /*return*/];
                    }
                    deployments = hre.deployments, getNamedAccounts = hre.getNamedAccounts;
                    deploy = deployments.deploy;
                    return [4 /*yield*/, getNamedAccounts()];
                case 1:
                    deployer = (_a.sent()).deployer;
                    return [4 /*yield*/, deploy(name, {
                            from: deployer,
                            log: true,
                            args: options === null || options === void 0 ? void 0 : options.args,
                            skipIfAlreadyDeployed: true,
                        })];
                case 2:
                    deployedFacet = _a.sent();
                    return [4 /*yield*/, hardhat_1.ethers.getContract(name)];
                case 3:
                    facet = _a.sent();
                    return [4 /*yield*/, hardhat_1.ethers.getContract(exports.diamondContractName)];
                case 4:
                    diamond = _a.sent();
                    return [4 /*yield*/, (0, diamond_1.addOrReplaceFacets)([facet], diamond.address)];
                case 5:
                    _a.sent();
                    return [4 /*yield*/, (0, exports.verifyContract)(hre, name, {
                            address: facet.address,
                            args: options === null || options === void 0 ? void 0 : options.args,
                        })];
                case 6:
                    isVerified = _a.sent();
                    return [4 /*yield*/, (0, exports.updateDeploymentLogs)(name, deployedFacet, isVerified)];
                case 7:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
};
exports.deployFacet = deployFacet;
var verifyContract = function (hre, name, options) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, _b, _c, _d, e_1;
        var _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    if (hardhat_1.network.name !== 'zksync' && hardhat_1.network.name !== 'zksyncGoerli') {
                        return [2 /*return*/];
                    }
                    _f.label = 1;
                case 1:
                    _f.trys.push([1, 5, , 6]);
                    _b = (_a = hre).run;
                    _c = ['verify:verify'];
                    _e = {};
                    _d = (options === null || options === void 0 ? void 0 : options.address);
                    if (_d) return [3 /*break*/, 3];
                    return [4 /*yield*/, hardhat_1.ethers.getContract(name)];
                case 2:
                    _d = (_f.sent()).address;
                    _f.label = 3;
                case 3: return [4 /*yield*/, _b.apply(_a, _c.concat([(_e.address = _d,
                            _e.constructorArguments = (options === null || options === void 0 ? void 0 : options.args) || [],
                            _e)]))];
                case 4:
                    _f.sent();
                    return [2 /*return*/, true];
                case 5:
                    e_1 = _f.sent();
                    console.log("Failed to verify ".concat(name, " contract: ").concat(e_1));
                    if (e_1.toString().includes('This contract is already verified')) {
                        return [2 /*return*/, true];
                    }
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/, false];
            }
        });
    });
};
exports.verifyContract = verifyContract;
