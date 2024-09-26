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
var L1ToL2MessageGasEstimator_1 = require("@arbitrum/sdk/dist/lib/message/L1ToL2MessageGasEstimator");
var sdk_1 = require("@arbitrum/sdk");
var typechain_1 = require("../typechain");
var network_1 = require("../../utils/network");
var chalk_1 = __importDefault(require("chalk"));
var arbitrum_1 = __importDefault(require("../config/arbitrum"));
var msg = function (msg) {
    console.log(chalk_1.default.green(msg));
};
// Test process
// Bridge Non-Native Asset
// Approve TEST for LiFiDiamond for swapping
// Swap TEST -> USDC via uniswap on Goerli
// Bridge USDC on Goerli -> USDC on Arbitrum Goerli via Arbitrum Native Bridge
// Bridge Native Asset
// Bridge ETH on Goerli -> ETH on Arbitrum Goerli via Arbitrum Native Bridge
var LIFI_ADDRESS = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'; // LiFiDiamond address on Goerli
var USDC_ADDRESS = '0x98339D8C260052B7ad81c28c16C0b98420f2B46a'; // USDC address on Goerli
var TEST_TOKEN_ADDRESS = '0x7ea6eA49B0b0Ae9c5db7907d139D9Cd3439862a1'; // TEST Token address on Goerli
var UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap router address on Goerli
var WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH address
var ZERO_ADDRESS = ethers_1.constants.AddressZero;
var destinationChainId = 421613; // Arbitrum Goerli chain id
var amountIn = ethers_1.utils.parseEther('1050');
var amountOut = ethers_1.utils.parseUnits('1000', 6);
var _a = sdk_1.RetryableDataTools.ErrorTriggeringParams, errorTriggerGasLimit = _a.gasLimit, errorTriggerMaxFeePerGas = _a.maxFeePerGas;
var errorTriggerCost = ethers_1.BigNumber.from(1).add(errorTriggerGasLimit.mul(errorTriggerMaxFeePerGas));
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var l1JsonProvider, l1Provider, l2JsonProvider, l2Provider, gasEstimator, wallet, walletAddress, lifi, l1GatewayRouter, l2GatewayRouter, token, usdc, uniswap, path, to, deadline, dexSwapData, swapData, bridgeData, deployData, _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, ABI, iface, outboundCalldata, estimates, _q, _r, _s, maxSubmissionCost, gasLimit, maxFeePerGas, maxGasLimit, arbitrumData, cost, allowance, amount, bridgeData, estimates, _t, _u, _v, maxSubmissionCost, gasLimit, maxFeePerGas, maxGasLimit, arbitrumData, cost, erc20AmountIn, ethAmountOut, usdc, uniswap, path, to, deadline, dexSwapData, swapData, bridgeData, estimates, _w, _x, _y, maxSubmissionCost, gasLimit, maxFeePerGas, maxGasLimit, arbitrumData, cost, allowance;
        var _z;
        return __generator(this, function (_0) {
            switch (_0.label) {
                case 0:
                    l1JsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('goerli'));
                    l1Provider = new ethers_1.providers.FallbackProvider([l1JsonProvider]);
                    l2JsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('arbitrum_goerli'));
                    l2Provider = new ethers_1.providers.FallbackProvider([l2JsonProvider]);
                    gasEstimator = new L1ToL2MessageGasEstimator_1.L1ToL2MessageGasEstimator(l2Provider);
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    wallet = wallet.connect(l1Provider);
                    return [4 /*yield*/, wallet.getAddress()];
                case 1:
                    walletAddress = _0.sent();
                    lifi = typechain_1.ArbitrumBridgeFacet__factory.connect(LIFI_ADDRESS, wallet);
                    l1GatewayRouter = typechain_1.IGatewayRouter__factory.connect(arbitrum_1.default['goerli'].gatewayRouter, l1Provider);
                    l2GatewayRouter = typechain_1.IGatewayRouter__factory.connect(arbitrum_1.default['goerli'].l2GatewayRouter, l2Provider);
                    token = typechain_1.ERC20__factory.connect(TEST_TOKEN_ADDRESS, wallet);
                    usdc = typechain_1.ERC20__factory.connect(USDC_ADDRESS, wallet);
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ]);
                    path = [TEST_TOKEN_ADDRESS, USDC_ADDRESS];
                    to = LIFI_ADDRESS // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactTokens(amountOut, amountIn, path, to, deadline)];
                case 2:
                    dexSwapData = _0.sent();
                    swapData = [
                        {
                            callTo: dexSwapData.to,
                            approveTo: dexSwapData.to,
                            sendingAssetId: TEST_TOKEN_ADDRESS,
                            receivingAssetId: USDC_ADDRESS,
                            fromAmount: amountIn,
                            callData: dexSwapData === null || dexSwapData === void 0 ? void 0 : dexSwapData.data,
                            requiresDeposit: true,
                        },
                    ];
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'arbitrum',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: USDC_ADDRESS,
                        receiver: walletAddress,
                        minAmount: amountOut,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: true,
                        hasDestinationCall: false,
                    };
                    _b = (_a = ethers_1.utils.defaultAbiCoder).encode;
                    _c = [['bytes', 'bytes', 'bytes']];
                    _e = (_d = ethers_1.utils).hexlify;
                    _g = (_f = ethers_1.utils).toUtf8Bytes;
                    return [4 /*yield*/, usdc.name()];
                case 3:
                    _h = [
                        _e.apply(_d, [_g.apply(_f, [_0.sent()])])
                    ];
                    _k = (_j = ethers_1.utils).hexlify;
                    _m = (_l = ethers_1.utils).toUtf8Bytes;
                    return [4 /*yield*/, usdc.symbol()];
                case 4:
                    _h = _h.concat([
                        _k.apply(_j, [_m.apply(_l, [_0.sent()])])
                    ]);
                    _p = (_o = ethers_1.utils).hexlify;
                    return [4 /*yield*/, usdc.decimals()];
                case 5:
                    deployData = _b.apply(_a, _c.concat([_h.concat([
                            _p.apply(_o, [_0.sent()])
                        ])]));
                    ABI = [
                        'function finalizeInboundTransfer(address,address,address,uint256,bytes)',
                    ];
                    iface = new ethers_1.utils.Interface(ABI);
                    outboundCalldata = iface.encodeFunctionData('finalizeInboundTransfer', [
                        USDC_ADDRESS, // L1 Token address
                        LIFI_ADDRESS,
                        walletAddress, // Receiver address
                        amountOut, // Sending amount
                        ethers_1.utils.defaultAbiCoder.encode(['bytes', 'bytes'], [deployData, '0x']),
                    ]);
                    _r = (_q = gasEstimator).estimateAll;
                    _z = {};
                    return [4 /*yield*/, l1GatewayRouter.getGateway(USDC_ADDRESS)];
                case 6:
                    _z.from = _0.sent();
                    return [4 /*yield*/, l2GatewayRouter.getGateway(USDC_ADDRESS)];
                case 7:
                    _s = [(_z.to = _0.sent(),
                            _z.data = outboundCalldata,
                            _z.l2CallValue = errorTriggerCost,
                            _z.excessFeeRefundAddress = walletAddress,
                            _z.callValueRefundAddress = walletAddress,
                            _z)];
                    return [4 /*yield*/, l1JsonProvider.getBlock('latest')];
                case 8: return [4 /*yield*/, _r.apply(_q, _s.concat([(_0.sent()).baseFeePerGas ||
                            ethers_1.BigNumber.from(0),
                        l1Provider]))
                    // =============================================================
                ];
                case 9:
                    estimates = _0.sent();
                    maxSubmissionCost = estimates.maxSubmissionCost, gasLimit = estimates.gasLimit, maxFeePerGas = estimates.maxFeePerGas;
                    maxGasLimit = gasLimit.add(64 * 12);
                    arbitrumData = {
                        maxSubmissionCost: maxSubmissionCost,
                        maxGas: maxGasLimit,
                        maxGasPrice: maxFeePerGas,
                    };
                    cost = maxSubmissionCost.add(maxFeePerGas.mul(maxGasLimit));
                    return [4 /*yield*/, token.allowance(walletAddress, LIFI_ADDRESS)];
                case 10:
                    allowance = _0.sent();
                    if (!amountIn.gt(allowance)) return [3 /*break*/, 12];
                    return [4 /*yield*/, token.approve(LIFI_ADDRESS, amountIn)];
                case 11:
                    _0.sent();
                    msg('Token approved for swapping');
                    _0.label = 12;
                case 12: 
                // Call LiFi smart contract to start the bridge process -- WITH SWAP
                return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaArbitrumBridge(bridgeData, swapData, arbitrumData, {
                        gasLimit: '500000',
                        value: cost,
                    })];
                case 13:
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    _0.sent();
                    amount = ethers_1.utils.parseEther('0.0001');
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'arbitrum',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: ZERO_ADDRESS,
                        receiver: walletAddress,
                        minAmount: amount,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: false,
                        hasDestinationCall: false,
                    };
                    _u = (_t = gasEstimator).estimateAll;
                    _v = [{
                            from: LIFI_ADDRESS,
                            to: walletAddress,
                            data: '0x',
                            l2CallValue: errorTriggerCost,
                            excessFeeRefundAddress: walletAddress,
                            callValueRefundAddress: walletAddress,
                        }];
                    return [4 /*yield*/, l1JsonProvider.getBlock('latest')];
                case 14: return [4 /*yield*/, _u.apply(_t, _v.concat([(_0.sent()).baseFeePerGas ||
                            ethers_1.BigNumber.from(0),
                        l1Provider]))
                    // =============================================================
                ];
                case 15:
                    estimates = _0.sent();
                    maxSubmissionCost = estimates.maxSubmissionCost, gasLimit = estimates.gasLimit, maxFeePerGas = estimates.maxFeePerGas;
                    maxGasLimit = gasLimit;
                    arbitrumData = {
                        maxSubmissionCost: maxSubmissionCost,
                        maxGas: maxGasLimit,
                        maxGasPrice: maxFeePerGas,
                    };
                    cost = maxSubmissionCost.add(maxFeePerGas.mul(maxGasLimit));
                    // Call LiFi smart contract to start the bridge process
                    return [4 /*yield*/, lifi.startBridgeTokensViaArbitrumBridge(bridgeData, arbitrumData, {
                            gasLimit: '500000',
                            value: amount.add(cost),
                        })];
                case 16:
                    // Call LiFi smart contract to start the bridge process
                    _0.sent();
                    erc20AmountIn = ethers_1.utils.parseUnits('1.5', 6);
                    ethAmountOut = ethers_1.utils.parseEther('0.001');
                    usdc = typechain_1.ERC20__factory.connect(USDC_ADDRESS, wallet);
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactETH(uint256,uint256,address[],address,uint256)',
                    ]);
                    path = [USDC_ADDRESS, WETH_ADDRESS];
                    to = lifi.address // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactETH(ethAmountOut, erc20AmountIn, path, to, deadline)];
                case 17:
                    dexSwapData = _0.sent();
                    swapData = [
                        {
                            callTo: dexSwapData.to,
                            approveTo: dexSwapData.to,
                            sendingAssetId: USDC_ADDRESS,
                            receivingAssetId: ZERO_ADDRESS,
                            fromAmount: erc20AmountIn,
                            callData: dexSwapData === null || dexSwapData === void 0 ? void 0 : dexSwapData.data,
                            requiresDeposit: true,
                        },
                    ];
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'arbitrum',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: ZERO_ADDRESS,
                        receiver: walletAddress,
                        minAmount: ethAmountOut,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: true,
                        hasDestinationCall: false,
                    };
                    _x = (_w = gasEstimator).estimateAll;
                    _y = [{
                            from: LIFI_ADDRESS,
                            to: walletAddress,
                            data: '0x',
                            l2CallValue: errorTriggerCost,
                            excessFeeRefundAddress: walletAddress,
                            callValueRefundAddress: walletAddress,
                        }];
                    return [4 /*yield*/, l1JsonProvider.getBlock('latest')];
                case 18: return [4 /*yield*/, _x.apply(_w, _y.concat([(_0.sent()).baseFeePerGas ||
                            ethers_1.BigNumber.from(0),
                        l1Provider]))
                    // =============================================================
                ];
                case 19:
                    estimates = _0.sent();
                    maxSubmissionCost = estimates.maxSubmissionCost, gasLimit = estimates.gasLimit, maxFeePerGas = estimates.maxFeePerGas;
                    maxGasLimit = gasLimit;
                    arbitrumData = {
                        maxSubmissionCost: maxSubmissionCost,
                        maxGas: maxGasLimit,
                        maxGasPrice: maxFeePerGas,
                    };
                    cost = maxSubmissionCost.add(maxFeePerGas.mul(maxGasLimit));
                    return [4 /*yield*/, usdc.allowance(walletAddress, LIFI_ADDRESS)];
                case 20:
                    allowance = _0.sent();
                    if (!erc20AmountIn.gt(allowance)) return [3 /*break*/, 22];
                    return [4 /*yield*/, usdc.approve(LIFI_ADDRESS, erc20AmountIn)];
                case 21:
                    _0.sent();
                    msg('Token approved for swapping');
                    _0.label = 22;
                case 22: 
                // Call LiFi smart contract to start the bridge process -- WITH SWAP
                return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaArbitrumBridge(bridgeData, swapData, arbitrumData, {
                        gasLimit: '500000',
                        value: cost,
                    })];
                case 23:
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    _0.sent();
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
