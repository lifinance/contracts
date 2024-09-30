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
var typechain_1 = require("../../typechain");
var network_1 = require("../../utils/network");
var polygon_staging_json_1 = __importDefault(require("../../deployments/polygon.staging.json"));
var optimism_staging_json_1 = __importDefault(require("../../deployments/optimism.staging.json"));
var stargate_json_1 = __importDefault(require("../../config/stargate.json"));
var lz_v2_utilities_1 = require("@layerzerolabs/lz-v2-utilities");
// SUCCESSFUL TX
// https://d3k4i7b673n27r.cloudfront.net/v1/buses/bus-queue/0xbe3e0ad093578b943fce18b139fe99c8afa40074935108cc98135785b1e4a9a8 (bus, no dstCall)
// https://layerzeroscan.com/tx/0x5f42d846f4b1710df9ab6950a40990eabc6a55b7456b24c82075f00426d52566 (taxi, with dstCall)
var USDC_OPT = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
var WETH_OPT = '0x4200000000000000000000000000000000000006';
var USDC_POL = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
var PAYLOAD_ABI = [
    'bytes32', // Transaction Id
    'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]', // Swap Data
    'address', // Receiver
];
var FEE_LIBRARY_ABI = [
    'function applyFeeView((address,uint32,uint64,uint64,bool,bool)) view returns (uint64)',
];
var VALID_EXTRA_OPTIONS_VALUE = '0x000301001303000000000000000000000000000000061a80'; // gives 400_000 gas on dstChain
var SRC_CHAIN = 'polygon';
var DST_CHAIN_ID = 10;
var DIAMOND_ADDRESS_SRC = polygon_staging_json_1.default.LiFiDiamond;
var RECEIVER_ADDRESS_DST = optimism_staging_json_1.default.ReceiverStargateV2;
var EXECUTOR_ADDRESS_DST = optimism_staging_json_1.default.Executor;
var STARGATE_POOL_USDC_POL = '0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4';
var UNISWAP_ADDRESS_DST = '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2'; // Uniswap OPT
var amountIn = ethers_1.utils.parseUnits('1', 5); // 0.1 USDC
var TAXI_EXPLORER_URL = 'https://layerzeroscan.com/tx/';
var BUS_EXPLORER_URL = 'https://d3k4i7b673n27r.cloudfront.net/v1/buses/bus-queue/';
var DEFAULT_GAS_STIPEND_FOR_DEST_CALLS = 400000; // 400k gas
// ############ CONFIGURE SCRIPT HERE ############################
var IS_TAXI = false; // Bus vs. Taxi mode
var WITH_DEST_CALL = true; // adds a dest call if set to true
var SEND_TX = false; // disable tx sending here for debugging purposes
// ###############################################################
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var ASSET_ID, rpcProviderSrc, providerSrc, wallet, walletAddress, stargateFacet, stargatePool, dstChainEid, sendParams, minAmountOutBridge, uniswap, path, deadline, uniswapCalldata, swapData, bridgeData, payload, messagingFee, stargateData, gasLimit, gasPrice, maxPriorityFeePerGas, maxFeePerGas, trx, baseURL;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    ASSET_ID = 1 // 1 = USDC on POL
                    ;
                    rpcProviderSrc = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)(SRC_CHAIN));
                    providerSrc = new ethers_1.providers.FallbackProvider([rpcProviderSrc]);
                    wallet = new ethers_1.Wallet(process.env.PRIVATE_KEY, providerSrc);
                    return [4 /*yield*/, wallet.getAddress()
                        // get contracts
                    ];
                case 1:
                    walletAddress = _a.sent();
                    stargateFacet = typechain_1.StargateFacetV2__factory.connect(DIAMOND_ADDRESS_SRC, wallet);
                    console.log('stargateFacet connected: ', stargateFacet.address);
                    stargatePool = typechain_1.IStargate__factory.connect(STARGATE_POOL_USDC_POL, wallet);
                    console.log('stargatePool connected: ', stargatePool.address);
                    dstChainEid = getEndpointId(DST_CHAIN_ID);
                    if (!dstChainEid)
                        throw Error("could not find endpointId for chain ".concat(DST_CHAIN_ID));
                    sendParams = {
                        dstEid: dstChainEid,
                        to: (0, lz_v2_utilities_1.addressToBytes32)(WITH_DEST_CALL ? RECEIVER_ADDRESS_DST : wallet.address),
                        amountLD: amountIn.toString(),
                        minAmountLD: 0, //minAmountOut (will be added later)
                        extraOptions: getExtraOptions(),
                        composeMsg: '0x', // payload (will be added later)
                        oftCmd: oftCmdHelper(),
                    };
                    console.log('sendParams initialized');
                    return [4 /*yield*/, getAmountOutFeeQuoteOFT(stargatePool, sendParams)];
                case 2:
                    minAmountOutBridge = _a.sent();
                    console.log("after getAmountOutFeeQuote: ".concat(minAmountOutBridge.toString()));
                    // update sendParams with minAmountOut
                    sendParams.minAmountLD = minAmountOutBridge;
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS_DST, [
                        'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ]);
                    path = [USDC_OPT, WETH_OPT];
                    deadline = Math.floor(Date.now() / 1000) + 60 * 60 // 60 minutes from the current Unix time
                    ;
                    return [4 /*yield*/, uniswap.populateTransaction.swapExactTokensForTokens(minAmountOutBridge, // amountIn
                        0, // amountOutMin
                        path, EXECUTOR_ADDRESS_DST, deadline)
                        // construct LibSwap.SwapData
                    ];
                case 3:
                    uniswapCalldata = _a.sent();
                    swapData = {
                        callTo: UNISWAP_ADDRESS_DST,
                        approveTo: UNISWAP_ADDRESS_DST,
                        sendingAssetId: USDC_OPT,
                        receivingAssetId: WETH_OPT,
                        fromAmount: minAmountOutBridge,
                        callData: uniswapCalldata.data,
                    };
                    console.log('dst swapData prepared');
                    bridgeData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        bridge: 'stargate',
                        integrator: 'demoScript',
                        referrer: '0x0000000000000000000000000000000000000000',
                        sendingAssetId: USDC_POL,
                        receiver: walletAddress,
                        minAmount: amountIn,
                        destinationChainId: DST_CHAIN_ID,
                        hasSourceSwaps: false,
                        hasDestinationCall: WITH_DEST_CALL,
                    };
                    console.log('bridgeData prepared');
                    payload = ethers_1.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
                        bridgeData.transactionId,
                        [swapData],
                        walletAddress, // receiver
                    ]);
                    console.log('payload prepared: ', payload);
                    // update payload in sendParams
                    sendParams.composeMsg = WITH_DEST_CALL ? payload : '0x';
                    return [4 /*yield*/, stargatePool.quoteSend(sendParams, false)];
                case 4:
                    messagingFee = _a.sent();
                    console.log('nativeFee quote received: ', messagingFee.nativeFee.toString());
                    // make sure that wallet has sufficient balance and allowance set for diamond
                    return [4 /*yield*/, ensureBalanceAndAllowanceToDiamond(USDC_POL, wallet, DIAMOND_ADDRESS_SRC, amountIn)
                        // construct StargateData
                    ];
                case 5:
                    // make sure that wallet has sufficient balance and allowance set for diamond
                    _a.sent();
                    stargateData = {
                        assetId: ASSET_ID,
                        sendParams: sendParams,
                        fee: messagingFee,
                        refundAddress: walletAddress,
                    };
                    console.log('stargateData prepared');
                    return [4 /*yield*/, stargateFacet.estimateGas.startBridgeTokensViaStargate(bridgeData, stargateData, {
                            value: messagingFee.nativeFee,
                        })];
                case 6:
                    gasLimit = _a.sent();
                    return [4 /*yield*/, providerSrc.getGasPrice()];
                case 7:
                    gasPrice = _a.sent();
                    maxPriorityFeePerGas = gasPrice.mul(2);
                    maxFeePerGas = gasPrice.mul(3);
                    if (!SEND_TX) return [3 /*break*/, 10];
                    console.log('executing src TX now');
                    return [4 /*yield*/, stargateFacet.startBridgeTokensViaStargate(bridgeData, stargateData, {
                            gasLimit: gasLimit,
                            maxPriorityFeePerGas: maxPriorityFeePerGas,
                            maxFeePerGas: maxFeePerGas,
                            value: messagingFee.nativeFee,
                        })];
                case 8:
                    trx = _a.sent();
                    console.log('calldata: ', trx.data);
                    return [4 /*yield*/, trx.wait()];
                case 9:
                    _a.sent();
                    baseURL = WITH_DEST_CALL || IS_TAXI ? TAXI_EXPLORER_URL : BUS_EXPLORER_URL;
                    console.log('src TX successfully executed: ', baseURL + trx.hash);
                    _a.label = 10;
                case 10:
                    console.log('end of script reached');
                    return [2 /*return*/];
            }
        });
    });
}
// Returns a value (extraOptions) that is used to signal Starcraft how much gas we need on dstChain (to execute our dst call)
// More info here: https://stargateprotocol.gitbook.io/stargate/v/v2-developer-docs/integrate-with-stargate/composability
// For this demo script we are using a hardcoded value that gives 400k gas stipend but ideally that value should be based on
// the dst payload size/cost
var getExtraOptions = function () {
    if (WITH_DEST_CALL) {
        return lz_v2_utilities_1.Options.newOptions()
            .addExecutorComposeOption(0, DEFAULT_GAS_STIPEND_FOR_DEST_CALLS, 0)
            .toHex();
    }
    else {
        return '0x';
    }
};
// get the amountOut at destination chain for a given amountIn based on sendParams
var getAmountOutFeeQuoteOFT = function (stargatePool, sendParams) { return __awaiter(void 0, void 0, void 0, function () {
    var resp, response;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, stargatePool.callStatic.quoteOFT(sendParams)];
            case 1:
                resp = _a.sent();
                response = transformQuoteOFTResponse(resp);
                if (!response)
                    throw "Could not get quoteOFT response for params: ".concat(JSON.stringify(sendParams, null, 2));
                if (response.oftLimit.maxAmountLD.isZero()) {
                    throw Error('Route has no credits and cannot be used');
                }
                // console.log(`QuoteOFT response: ${JSON.stringify(response, null, 2)}`)
                return [2 /*return*/, response.oftReceipt.amountReceivedLD];
        }
    });
}); };
// Takes a smart contract response and converts it to typed data
function transformQuoteOFTResponse(response) {
    var oftLimit = {
        minAmountLD: ethers_1.BigNumber.from(response[0][0]),
        maxAmountLD: ethers_1.BigNumber.from(response[0][1]), // if this value is 0 then the route has no credits i.e. cannot be used
    };
    var feeDetail = response[1].map(function (feeDetail) { return ({
        feeAmountLD: ethers_1.BigNumber.from(feeDetail[0]),
        description: feeDetail[1],
    }); });
    var oftReceipt = {
        amountSentLD: ethers_1.BigNumber.from(response[2][0]),
        amountReceivedLD: ethers_1.BigNumber.from(response[2][1]),
    };
    return {
        oftLimit: oftLimit,
        feeDetail: feeDetail,
        oftReceipt: oftReceipt,
    };
}
// This endpoint returns all tokens, their pools/routers and assetIds
function getSupportedTokensAndPools() {
    return __awaiter(this, void 0, void 0, function () {
        var resp, responseJson, filtered;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fetch('https://d3k4i7b673n27r.cloudfront.net/v1/metadata?version=v2')];
                case 1:
                    resp = _a.sent();
                    return [4 /*yield*/, resp.json()
                        // console.log(`response: ${JSON.stringify(responseJson.data.v2, null, 2)}`)
                    ];
                case 2:
                    responseJson = _a.sent();
                    filtered = responseJson.data.v2.match(function (pool) {
                        pool.chain;
                        pool.tokenMessaging;
                    });
                    console.log("filtered: ".concat(JSON.stringify(filtered, null, 2)));
                    return [2 /*return*/];
            }
        });
    });
}
// returns the LayerZero Eid (Endpoint ID) for a given chainId
// Full list here: https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
function getEndpointId(chainId) {
    var chain = stargate_json_1.default.endpointIds.find(function (chain) { return chain.chainId === chainId; });
    return chain ? chain.endpointId : undefined;
}
// makes sure the sending wallet has sufficient balance and registers approval in the sending token from wallet to our diamond
var ensureBalanceAndAllowanceToDiamond = function (tokenAddress, wallet, diamondAddress, amount) { return __awaiter(void 0, void 0, void 0, function () {
    var token, allowance, balance;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                token = typechain_1.ERC20__factory.connect(tokenAddress, wallet);
                return [4 /*yield*/, token.allowance(wallet.address, diamondAddress)];
            case 1:
                allowance = _a.sent();
                console.log('current allowance: %s ', allowance);
                if (!amount.gt(allowance)) return [3 /*break*/, 3];
                return [4 /*yield*/, token.approve(diamondAddress, amount)];
            case 2:
                _a.sent();
                console.log('allowance set to: ', amount);
                _a.label = 3;
            case 3: return [4 /*yield*/, token.balanceOf(wallet.address)];
            case 4:
                balance = _a.sent();
                if (amount.gt(balance))
                    throw Error("Wallet has insufficient balance (should have ".concat(amount, " but only has ").concat(balance, ")"));
                return [2 /*return*/];
        }
    });
}); };
// returns a value that signals Stargate to either use Taxi or Bus mode
function oftCmdHelper() {
    var BYTES_TAXI_MODE = '0x';
    var BYTES_BUS_MODE = new Uint8Array(1);
    // destination calls only work with taxi mode
    return WITH_DEST_CALL || IS_TAXI ? BYTES_TAXI_MODE : BYTES_BUS_MODE;
}
// we probably do not need the FeeLib anymore since we can all quote info via quoteOFT() and quoteSend()
// Keeping this here for reference
var getAmountOutFeeLib = function (feeLibAddress, provider, wallet, dstEid, amountInSD, deficitSD, toOFT, isTaxi) {
    if (toOFT === void 0) { toOFT = false; }
    if (isTaxi === void 0) { isTaxi = false; }
    return __awaiter(void 0, void 0, void 0, function () {
        var feeParams, feeLibrary, amountOut, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    feeParams = {
                        sender: wallet.address,
                        // dstEid: dstEid,
                        dstEid: dstEid,
                        amountInSD: amountInSD,
                        deficitSD: deficitSD,
                        toOFT: toOFT,
                        isTaxi: isTaxi,
                    };
                    feeLibrary = new ethers_1.Contract(feeLibAddress, FEE_LIBRARY_ABI, provider);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, feeLibrary.callStatic.applyFeeView([
                            feeParams.sender,
                            feeParams.dstEid,
                            feeParams.amountInSD,
                            feeParams.deficitSD,
                            feeParams.toOFT,
                            feeParams.isTaxi,
                        ])];
                case 2:
                    amountOut = _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    console.error("Error calling applyFeeView:", error_1);
                    return [3 /*break*/, 4];
                case 4:
                    if (!amountOut)
                        throw Error("Could not get amountOut for params: ".concat(JSON.stringify(feeParams, null, 2)));
                    return [2 /*return*/, amountOut];
            }
        });
    });
};
main()
    .then(function () { return process.exit(0); })
    .catch(function (error) {
    console.error(error);
    console.log('Script ended with errors :/');
    process.exit(1);
});
