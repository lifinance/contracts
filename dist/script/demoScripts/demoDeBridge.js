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
var chalk_1 = __importDefault(require("chalk"));
var debridge_json_1 = require("../../config/debridge.json");
var msg = function (msg) {
    console.log(chalk_1.default.green(msg));
};
var LIFI_ADDRESS = '0xF0e74c6438bBC9997534860968A59C70223CC53C';
var DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
var USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
var UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
var ZERO_ADDRESS = ethers_1.constants.AddressZero;
var destinationChainId = 56;
var amountIn = ethers_1.utils.parseUnits('5', 18);
var amountOut = ethers_1.utils.parseUnits('4', 6);
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var jsonProvider, provider, wallet, walletAddress, lifi, deBridgeGate, path, to, deadline, uniswap, dexSwapData, swapData, bridgeData, chainConfig, nativeFee, _a, deBridgeData, dai, allowance, amount, bridgeData, chainConfig, nativeFee, _b, deBridgeData;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    jsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('polygon'));
                    provider = new ethers_1.providers.FallbackProvider([jsonProvider]);
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    wallet = wallet.connect(provider);
                    return [4 /*yield*/, wallet.getAddress()];
                case 1:
                    walletAddress = _c.sent();
                    lifi = typechain_1.DeBridgeFacet__factory.connect(LIFI_ADDRESS, wallet);
                    deBridgeGate = typechain_1.IDeBridgeGate__factory.connect(debridge_json_1.config['polygon'].deBridgeGate, provider);
                    path = [DAI_ADDRESS, USDC_ADDRESS];
                    to = LIFI_ADDRESS // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ], wallet);
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactTokens(amountOut, amountIn, path, to, deadline)];
                case 2:
                    dexSwapData = _c.sent();
                    swapData = [
                        {
                            callTo: dexSwapData.to,
                            approveTo: dexSwapData.to,
                            sendingAssetId: DAI_ADDRESS,
                            receivingAssetId: USDC_ADDRESS,
                            fromAmount: amountIn,
                            callData: dexSwapData === null || dexSwapData === void 0 ? void 0 : dexSwapData.data,
                            requiresDeposit: true,
                        },
                    ];
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'debridge',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: USDC_ADDRESS,
                        receiver: walletAddress,
                        minAmount: amountOut,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: true,
                        hasDestinationCall: false,
                    };
                    return [4 /*yield*/, deBridgeGate.getChainToConfig(destinationChainId)];
                case 3:
                    chainConfig = _c.sent();
                    if (!chainConfig.fixedNativeFee.isZero()) return [3 /*break*/, 5];
                    return [4 /*yield*/, deBridgeGate.globalFixedNativeFee()];
                case 4:
                    _a = _c.sent();
                    return [3 /*break*/, 6];
                case 5:
                    _a = chainConfig.fixedNativeFee;
                    _c.label = 6;
                case 6:
                    nativeFee = _a;
                    deBridgeData = {
                        permit: '0x',
                        nativeFee: nativeFee,
                        useAssetFee: false,
                        referralCode: 0,
                        autoParams: {
                            executionFee: ethers_1.utils.parseUnits('1', 6),
                            flags: 1, // REVERT_IF_EXTERNAL_FAIL
                            fallbackAddress: walletAddress,
                            data: '0x',
                        },
                    };
                    dai = typechain_1.ERC20__factory.connect(DAI_ADDRESS, wallet);
                    return [4 /*yield*/, dai.allowance(walletAddress, LIFI_ADDRESS)];
                case 7:
                    allowance = _c.sent();
                    if (!amountIn.gt(allowance)) return [3 /*break*/, 9];
                    return [4 /*yield*/, dai.approve(LIFI_ADDRESS, amountIn)];
                case 8:
                    _c.sent();
                    msg('Token approved for swapping');
                    _c.label = 9;
                case 9: 
                // Call LiFi smart contract to start the bridge process -- WITH SWAP
                return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaDeBridge(bridgeData, swapData, deBridgeData, {
                        value: nativeFee,
                        gasLimit: 500000,
                    })];
                case 10:
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    _c.sent();
                    amount = ethers_1.utils.parseEther('1');
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'debridge',
                        integrator: 'ACME Devs',
                        referrer: ZERO_ADDRESS,
                        sendingAssetId: ZERO_ADDRESS,
                        receiver: walletAddress,
                        minAmount: amount,
                        destinationChainId: destinationChainId,
                        hasSourceSwaps: false,
                        hasDestinationCall: false,
                    };
                    return [4 /*yield*/, deBridgeGate.getChainToConfig(destinationChainId)];
                case 11:
                    chainConfig = _c.sent();
                    if (!chainConfig.fixedNativeFee.isZero()) return [3 /*break*/, 13];
                    return [4 /*yield*/, deBridgeGate.globalFixedNativeFee()];
                case 12:
                    _b = _c.sent();
                    return [3 /*break*/, 14];
                case 13:
                    _b = chainConfig.fixedNativeFee;
                    _c.label = 14;
                case 14:
                    nativeFee = _b;
                    deBridgeData = {
                        permit: '0x',
                        nativeFee: nativeFee,
                        useAssetFee: false,
                        referralCode: 0,
                        autoParams: {
                            executionFee: ethers_1.utils.parseEther('0.8'),
                            flags: 1, // REVERT_IF_EXTERNAL_FAIL
                            fallbackAddress: walletAddress,
                            data: '0x',
                        },
                    };
                    // Call LiFi smart contract to start the bridge process
                    return [4 /*yield*/, lifi.startBridgeTokensViaDeBridge(bridgeData, deBridgeData, {
                            value: amount.add(nativeFee),
                            gasLimit: 500000,
                        })];
                case 15:
                    // Call LiFi smart contract to start the bridge process
                    _c.sent();
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
