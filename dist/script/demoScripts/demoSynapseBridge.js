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
var ethers_1 = require("ethers");
var typechain_1 = require("../typechain");
var network_1 = require("../../utils/network");
var synapse_json_1 = __importDefault(require("../../config/synapse.json"));
var polygon_staging_json_1 = __importDefault(require("../../deployments/polygon.staging.json"));
var chalk_1 = __importDefault(require("chalk"));
var msg = function (msg) {
    console.log(chalk_1.default.green(msg));
};
var LIFI_ADDRESS = polygon_staging_json_1.default.LiFiDiamond;
var POLYGON_DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
var POLYGON_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
var BSC_BUSD_ADDRESS = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
var UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
var ZERO_ADDRESS = ethers_1.constants.AddressZero;
var ONE = ethers_1.constants.One;
var destinationChainId = 56;
var amountIn = ethers_1.utils.parseUnits('5', 18);
var amountOut = ethers_1.utils.parseUnits('4', 6);
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var jsonProvider, provider, wallet, walletAddress, lifi, path, to, deadline, uniswap, dexSwapData, swapData, bridgeData, synapseData, dai, allowance, amount, bridgeData, deadline, synapseData;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    jsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('polygon'));
                    provider = new ethers_1.providers.FallbackProvider([jsonProvider]);
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    wallet = wallet.connect(provider);
                    return [4 /*yield*/, wallet.getAddress()];
                case 1:
                    walletAddress = _a.sent();
                    lifi = typechain_1.SynapseBridgeFacet__factory.connect(LIFI_ADDRESS, wallet);
                    path = [POLYGON_DAI_ADDRESS, POLYGON_USDC_ADDRESS];
                    to = LIFI_ADDRESS // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ], wallet);
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactTokens(amountOut, amountIn, path, to, deadline)];
                case 2:
                    dexSwapData = _a.sent();
                    swapData = [
                        {
                            callTo: dexSwapData.to,
                            approveTo: dexSwapData.to,
                            sendingAssetId: POLYGON_DAI_ADDRESS,
                            receivingAssetId: POLYGON_USDC_ADDRESS,
                            fromAmount: amountIn,
                            callData: dexSwapData === null || dexSwapData === void 0 ? void 0 : dexSwapData.data,
                            requiresDeposit: true,
                        },
                    ];
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'synapse',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: POLYGON_USDC_ADDRESS,
                        receiver: walletAddress,
                        minAmount: amountOut,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: true,
                        hasDestinationCall: false,
                    };
                    return [4 /*yield*/, getSynapseDataQueries('polygon', 'bsc', POLYGON_USDC_ADDRESS, BSC_BUSD_ADDRESS, amountOut, 0.05, // Slippage
                        deadline // Deadline
                        )
                        // Approve ERC20 for swapping -- DAI -> USDC
                    ];
                case 3:
                    synapseData = _a.sent();
                    dai = typechain_1.ERC20__factory.connect(POLYGON_DAI_ADDRESS, wallet);
                    return [4 /*yield*/, dai.allowance(walletAddress, LIFI_ADDRESS)];
                case 4:
                    allowance = _a.sent();
                    if (!amountIn.gt(allowance)) return [3 /*break*/, 6];
                    return [4 /*yield*/, dai.approve(LIFI_ADDRESS, amountIn)];
                case 5:
                    _a.sent();
                    msg('Token approved for swapping');
                    _a.label = 6;
                case 6: 
                // Call LiFi smart contract to start the bridge process -- WITH SWAP
                return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaSynapseBridge(bridgeData, swapData, synapseData, {
                        gasLimit: 500000,
                    })];
                case 7:
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    _a.sent();
                    amount = ethers_1.utils.parseEther('0.1');
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'synapse',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: ZERO_ADDRESS,
                        receiver: walletAddress,
                        minAmount: amount,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: false,
                        hasDestinationCall: false,
                    };
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    return [4 /*yield*/, getSynapseDataQueries('polygon', 'bsc', ZERO_ADDRESS, ZERO_ADDRESS, amount, 0.05, // Slippage
                        deadline // Deadline
                        )
                        // Call LiFi smart contract to start the bridge process
                    ];
                case 8:
                    synapseData = _a.sent();
                    // Call LiFi smart contract to start the bridge process
                    return [4 /*yield*/, lifi.startBridgeTokensViaSynapseBridge(bridgeData, synapseData, {
                            value: amount,
                            gasLimit: 500000,
                        })];
                case 9:
                    // Call LiFi smart contract to start the bridge process
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function getSynapseDataQueries(srcChain, dstChain, srcToken, dstToken, amount, slippage, deadline) {
    return __awaiter(this, void 0, void 0, function () {
        var NETH_ADDRESS, srcJsonProvider, srcProvider, dstJsonProvider, dstProvider, srcSynapseRouter, dstSynapseRouter, dstBridgeTokens, dstSymbols, originQueries, requests, destQueries, selectedIndex, i, originQuery, destQuery;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    NETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
                    srcJsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)(srcChain));
                    srcProvider = new ethers_1.providers.FallbackProvider([srcJsonProvider]);
                    dstJsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)(dstChain));
                    dstProvider = new ethers_1.providers.FallbackProvider([dstJsonProvider]);
                    srcSynapseRouter = typechain_1.ISynapseRouter__factory.connect(synapse_json_1.default[srcChain].router, srcProvider);
                    dstSynapseRouter = typechain_1.ISynapseRouter__factory.connect(synapse_json_1.default[dstChain].router, dstProvider);
                    return [4 /*yield*/, dstSynapseRouter.getConnectedBridgeTokens(dstToken == ZERO_ADDRESS ? NETH_ADDRESS : dstToken)];
                case 1:
                    dstBridgeTokens = _a.sent();
                    dstSymbols = dstBridgeTokens.map(function (token) { return token.symbol; });
                    return [4 /*yield*/, srcSynapseRouter.getOriginAmountOut(srcToken == ZERO_ADDRESS ? NETH_ADDRESS : srcToken, dstSymbols, amount)];
                case 2:
                    originQueries = _a.sent();
                    requests = dstSymbols.map(function (value, index) { return ({
                        symbol: value,
                        amountIn: originQueries[index].minAmountOut,
                    }); });
                    return [4 /*yield*/, dstSynapseRouter.getDestinationAmountOut(requests, dstToken == ZERO_ADDRESS ? NETH_ADDRESS : dstToken)];
                case 3:
                    destQueries = _a.sent();
                    selectedIndex = 0;
                    for (i = 0; i < destQueries.length; i++) {
                        if (destQueries[selectedIndex].minAmountOut < destQueries[i].minAmountOut) {
                            selectedIndex = i;
                        }
                    }
                    originQuery = originQueries[selectedIndex];
                    destQuery = destQueries[selectedIndex];
                    return [2 /*return*/, {
                            originQuery: {
                                swapAdapter: originQuery.swapAdapter,
                                tokenOut: originQuery.tokenOut,
                                minAmountOut: originQuery.minAmountOut
                                    .mul(ONE.sub(ethers_1.utils.parseEther(slippage.toString())))
                                    .div(ONE),
                                deadline: deadline,
                                rawParams: originQuery.rawParams,
                            },
                            destQuery: {
                                swapAdapter: destQuery.swapAdapter,
                                tokenOut: destQuery.tokenOut,
                                minAmountOut: destQuery.minAmountOut
                                    .mul(ONE.sub(ethers_1.utils.parseEther(slippage.toString())))
                                    .div(ONE),
                                deadline: deadline,
                                rawParams: destQuery.rawParams,
                            },
                        }];
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
