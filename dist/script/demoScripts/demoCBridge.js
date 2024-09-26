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
var chalk_1 = __importDefault(require("chalk"));
var deployment = __importStar(require("../export/deployments-staging.json"));
var msg = function (msg) {
    console.log(chalk_1.default.green(msg));
};
var LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address;
var destinationChainId = 56;
var MAX_SLIPPAGE = 1000000;
var POLYGON_USDT_ADDRESS = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
var POLYGON_USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
var BSC_USDC_ADDRESS = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
var UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var wallet, provider1, provider, lifi, amountIn, amountOut, path, to, deadline, uniswap, token, lifiData, CBridgeData, _a, _b, swapData, _c, _d;
        var _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    provider1 = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('polygon'));
                    provider = new ethers_1.providers.FallbackProvider([provider1]);
                    wallet = wallet.connect(provider);
                    lifi = typechain_1.CBridgeFacet__factory.connect(LIFI_ADDRESS, wallet);
                    console.log('ADDRESS', lifi.address);
                    amountIn = '25000000';
                    amountOut = '20000010';
                    path = [POLYGON_USDC_ADDRESS, POLYGON_USDT_ADDRESS];
                    to = LIFI_ADDRESS // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ], wallet);
                    token = typechain_1.ERC20__factory.connect(POLYGON_USDC_ADDRESS, wallet);
                    return [4 /*yield*/, token.approve(lifi.address, amountOut)];
                case 1:
                    _h.sent();
                    _e = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        integrator: 'ACME Devs',
                        referrer: ethers_1.constants.AddressZero,
                        sendingAssetId: POLYGON_USDC_ADDRESS,
                        receivingAssetId: BSC_USDC_ADDRESS
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 2:
                    lifiData = (_e.receiver = _h.sent(),
                        _e.destinationChainId = destinationChainId,
                        _e.amount = amountOut.toString(),
                        _e);
                    _f = {};
                    return [4 /*yield*/, wallet.getAddress()];
                case 3:
                    _f.receiver = _h.sent(),
                        _f.token = POLYGON_USDC_ADDRESS,
                        _f.amount = amountOut.toString(),
                        _f.dstChainId = destinationChainId;
                    _b = (_a = provider).getBlock;
                    return [4 /*yield*/, provider.getBlockNumber()];
                case 4: return [4 /*yield*/, _b.apply(_a, [_h.sent()])];
                case 5:
                    CBridgeData = (_f.nonce = (_h.sent()).timestamp,
                        _f.maxSlippage = MAX_SLIPPAGE,
                        _f);
                    // Test for startBridgeTokensViaCBridge
                    return [4 /*yield*/, lifi.startBridgeTokensViaCBridge(lifiData, CBridgeData, {
                            gasLimit: 500000,
                        })
                        // Test for swapAndStartBridgeTokensViaCBridge
                        // Generate swap calldata
                    ];
                case 6:
                    // Test for startBridgeTokensViaCBridge
                    _h.sent();
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactTokens(amountOut, amountIn, path, to, deadline)
                        // Approve ERC20 for swapping -- USDT
                    ];
                case 7:
                    swapData = _h.sent();
                    // Approve ERC20 for swapping -- USDT
                    return [4 /*yield*/, token.approve(lifi.address, amountOut)];
                case 8:
                    // Approve ERC20 for swapping -- USDT
                    _h.sent();
                    msg('Token approved for swapping');
                    _g = {};
                    return [4 /*yield*/, wallet.getAddress()];
                case 9:
                    _g.receiver = _h.sent(),
                        _g.token = POLYGON_USDT_ADDRESS,
                        _g.amount = amountOut.toString(),
                        _g.dstChainId = destinationChainId;
                    _d = (_c = provider).getBlock;
                    return [4 /*yield*/, provider.getBlockNumber()];
                case 10: return [4 /*yield*/, _d.apply(_c, [_h.sent()])];
                case 11:
                    CBridgeData = (_g.nonce = (_h.sent()).timestamp,
                        _g.maxSlippage = MAX_SLIPPAGE,
                        _g);
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaCBridge(lifiData, [
                            {
                                sendingAssetId: POLYGON_USDC_ADDRESS,
                                approveTo: swapData.to,
                                receivingAssetId: POLYGON_USDT_ADDRESS,
                                fromAmount: amountIn,
                                callTo: swapData.to,
                                callData: swapData === null || swapData === void 0 ? void 0 : swapData.data,
                            },
                        ], CBridgeData, { gasLimit: 500000 })];
                case 12:
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    _h.sent();
                    return [2 /*return*/];
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
