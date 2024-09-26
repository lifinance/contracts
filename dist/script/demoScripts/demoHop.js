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
var ethers_1 = require("ethers");
var typechain_1 = require("../typechain");
var network_1 = require("../../utils/network");
var deployment = __importStar(require("../export/deployments-staging.json"));
var sdk_1 = require("@hop-protocol/sdk");
var utils_1 = require("ethers/lib/utils");
var chalk_1 = __importDefault(require("chalk"));
var msg = function (msg) {
    console.log(chalk_1.default.green(msg));
};
var LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address;
var POLYGON_USDT_ADDRESS = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
var POLYGON_USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
var UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
var amountToSwap = '2';
var destinationChainId = 100;
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var hop, wallet, provider, lifi, bridge, HopData, amountIn, amountOut, fee, path, to, deadline, uniswap, swapData, token, lifiData, tx, receipt, token, amount, fee, deadline, lifiData, tx, receipt;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    hop = new sdk_1.Hop('mainnet');
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    provider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('polygon'));
                    wallet = wallet.connect(provider);
                    lifi = typechain_1.HopFacet__factory.connect(LIFI_ADDRESS, wallet);
                    bridge = hop.connect(provider).bridge('USDC');
                    if (!process.argv.includes('--swap')) return [3 /*break*/, 8];
                    msg('Swap + bridge');
                    amountIn = (0, utils_1.parseUnits)('2', 6);
                    amountOut = (0, utils_1.parseUnits)('2', 6);
                    msg('Getting Hop info...');
                    return [4 /*yield*/, bridge.getTotalFee(amountOut, sdk_1.Chain.Polygon, sdk_1.Chain.Gnosis)];
                case 1:
                    fee = _e.sent();
                    path = [POLYGON_USDT_ADDRESS, POLYGON_USDC_ADDRESS];
                    to = LIFI_ADDRESS // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 120 // 2 hours from the current Unix time
                    ;
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ], wallet);
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactTokens(amountOut, amountIn, path, to, deadline)];
                case 2:
                    swapData = _e.sent();
                    token = typechain_1.ERC20__factory.connect(POLYGON_USDC_ADDRESS, wallet);
                    // Approve ERC20 for swapping -- USDT -> USDC
                    return [4 /*yield*/, token.approve(lifi.address, amountIn)];
                case 3:
                    // Approve ERC20 for swapping -- USDT -> USDC
                    _e.sent();
                    msg('Token approved for swapping');
                    _a = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        integrator: 'ACME Devs',
                        referrer: ethers_1.constants.AddressZero,
                        sendingAssetId: POLYGON_USDC_ADDRESS,
                        receivingAssetId: POLYGON_USDT_ADDRESS
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 4:
                    lifiData = (_a.receiver = _e.sent(),
                        _a.destinationChainId = destinationChainId,
                        _a.amount = amountOut.toString(),
                        _a);
                    _b = {
                        asset: 'USDC',
                        chainId: destinationChainId
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 5:
                    HopData = (_b.recipient = _e.sent(),
                        _b.amount = (0, utils_1.parseUnits)('0.05', 6),
                        _b.bonderFee = fee,
                        _b.amountOutMin = (0, utils_1.parseUnits)('0.04', 6),
                        _b.deadline = deadline,
                        _b.destinationAmountOutMin = (0, utils_1.parseUnits)('0.03', 6),
                        _b.destinationDeadline = deadline,
                        _b);
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    msg('Sending...');
                    return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaHop(lifiData, [
                            {
                                sendingAssetId: POLYGON_USDC_ADDRESS,
                                approveTo: swapData.to,
                                receivingAssetId: POLYGON_USDT_ADDRESS,
                                fromAmount: amountIn,
                                callTo: swapData.to,
                                callData: swapData === null || swapData === void 0 ? void 0 : swapData.data,
                            },
                        ], HopData, { gasLimit: 900000 })];
                case 6:
                    tx = _e.sent();
                    msg(tx.hash);
                    return [4 /*yield*/, tx.wait()];
                case 7:
                    receipt = _e.sent();
                    msg(receipt.status ? 'SUCCESS' : 'REVERTED');
                    return [3 /*break*/, 15];
                case 8:
                    msg('Bridge without swap');
                    token = typechain_1.ERC20__factory.connect(POLYGON_USDC_ADDRESS, wallet);
                    amount = ethers_1.utils.parseUnits(amountToSwap, 6);
                    return [4 /*yield*/, token.approve(lifi.address, amount)];
                case 9:
                    _e.sent();
                    msg('Getting Hop info...');
                    return [4 /*yield*/, bridge.getTotalFee(amount, sdk_1.Chain.Polygon, sdk_1.Chain.Gnosis)];
                case 10:
                    fee = _e.sent();
                    deadline = Math.floor(Date.now() / 1000) + 60 * 120 // 2 hours from the current Unix time
                    ;
                    _c = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        integrator: 'ACME Devs',
                        referrer: ethers_1.constants.AddressZero,
                        sendingAssetId: token.address,
                        receivingAssetId: token.address
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 11:
                    lifiData = (_c.receiver = _e.sent(),
                        _c.destinationChainId = destinationChainId,
                        _c.amount = amount.toString(),
                        _c);
                    _d = {
                        asset: 'USDC',
                        chainId: destinationChainId
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 12:
                    HopData = (_d.recipient = _e.sent(),
                        _d.amount = amount,
                        _d.bonderFee = fee,
                        _d.amountOutMin = (0, utils_1.parseUnits)('0.9', 6),
                        _d.deadline = deadline,
                        _d.destinationAmountOutMin = (0, utils_1.parseUnits)('0.8', 6),
                        _d.destinationDeadline = deadline,
                        _d);
                    msg('Sending...');
                    return [4 /*yield*/, lifi.startBridgeTokensViaHop(lifiData, HopData, {
                            gasLimit: 500000,
                        })];
                case 13:
                    tx = _e.sent();
                    msg(tx.hash);
                    return [4 /*yield*/, tx.wait()];
                case 14:
                    receipt = _e.sent();
                    msg(receipt.status ? 'SUCCESS' : 'REVERTED');
                    _e.label = 15;
                case 15: return [2 /*return*/];
            }
        });
    });
}
main()
    .then(function () {
    console.log('Success');
    process.exit(0);
})
    .catch(function (error) {
    console.error('error');
    console.error(error);
    process.exit(1);
});
