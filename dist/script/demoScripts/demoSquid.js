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
var polygon_staging_json_1 = __importDefault(require("../../deployments/polygon.staging.json"));
var typechain_1 = require("../typechain");
var ethers_1 = require("ethers");
var dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
var ROUTE_TYPES = {
    CALL_BRIDGE: 0,
    BRIDGE_CALL: 1,
    CALL_BRIDGE_CALL: 2,
};
var main = function () { return __awaiter(void 0, void 0, void 0, function () {
    var RPC_URL, PRIVATE_KEY, LIFI_ADDRESS, provider, signer, squidFacet, route, routeJson, token, iface, decodedData, bridgeData, squidData, txRequest, value, maxFeePerGas, maxPriorityFeePerGas, tx;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                RPC_URL = process.env.ETH_NODE_URI_BSC;
                PRIVATE_KEY = process.env.PRIVATE_KEY;
                LIFI_ADDRESS = polygon_staging_json_1.default.LiFiDiamond;
                provider = new ethers_1.ethers.providers.JsonRpcProvider(RPC_URL);
                signer = new ethers_1.ethers.Wallet(PRIVATE_KEY, provider);
                squidFacet = typechain_1.SquidFacet__factory.connect(LIFI_ADDRESS, provider);
                return [4 /*yield*/, fetch('https://api.0xsquid.com/v1/route?fromChain=56&toChain=42161&fromToken=0x55d398326f99059fF775485246999027B3197955&toToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&fromAmount=5000000000000000000&toAddress=0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0&slippage=1')];
            case 1:
                route = _a.sent();
                return [4 /*yield*/, route.json()];
            case 2:
                routeJson = _a.sent();
                token = typechain_1.ERC20__factory.connect(routeJson.route.params.fromToken.address, provider);
                iface = typechain_1.ISquidRouter__factory.createInterface();
                switch (routeJson.route.transactionRequest.routeType) {
                    case 'CALL_BRIDGE':
                        decodedData = iface.decodeFunctionData('callBridge', routeJson.route.transactionRequest.data);
                        break;
                    case 'BRIDGE_CALL':
                        decodedData = iface.decodeFunctionData('bridgeCall', routeJson.route.transactionRequest.data);
                        break;
                    case 'CALL_BRIDGE_CALL':
                        decodedData = iface.decodeFunctionData('callBridgeCall', routeJson.route.transactionRequest.data);
                        break;
                }
                bridgeData = {
                    transactionId: ethers_1.utils.randomBytes(32),
                    bridge: 'Squid',
                    integrator: 'ACME Devs',
                    referrer: '0x0000000000000000000000000000000000000000',
                    sendingAssetId: routeJson.route.params.fromToken.address,
                    receiver: routeJson.route.params.toAddress,
                    minAmount: routeJson.route.params.fromAmount,
                    destinationChainId: routeJson.route.params.toChain,
                    hasSourceSwaps: (decodedData === null || decodedData === void 0 ? void 0 : decodedData.sourceCalls.length) > 0,
                    hasDestinationCall: (decodedData === null || decodedData === void 0 ? void 0 : decodedData.destinationCalls.length) > 0,
                };
                squidData = {
                    routeType: ROUTE_TYPES[routeJson.route.transactionRequest.routeType],
                    destinationChain: decodedData === null || decodedData === void 0 ? void 0 : decodedData.destinationChain,
                    bridgedTokenSymbol: decodedData === null || decodedData === void 0 ? void 0 : decodedData.bridgedTokenSymbol,
                    sourceCalls: (decodedData === null || decodedData === void 0 ? void 0 : decodedData.sourceCalls) || [],
                    destinationCalls: (decodedData === null || decodedData === void 0 ? void 0 : decodedData.destinationCalls) || [],
                    fee: routeJson.route.estimate.feeCosts[0].amount, // Could be multiple fees
                    forecallEnabled: routeJson.route.transactionRequest.forecallEnabled,
                };
                txRequest = routeJson.route.transactionRequest;
                value = txRequest.value, maxFeePerGas = txRequest.maxFeePerGas, maxPriorityFeePerGas = txRequest.maxPriorityFeePerGas;
                return [4 /*yield*/, token
                        .connect(signer)
                        .approve(LIFI_ADDRESS, bridgeData.minAmount, {
                        maxFeePerGas: maxFeePerGas,
                        maxPriorityFeePerGas: maxPriorityFeePerGas,
                    })];
            case 3:
                tx = _a.sent();
                return [4 /*yield*/, tx.wait()];
            case 4:
                _a.sent();
                return [4 /*yield*/, squidFacet
                        .connect(signer)
                        .startBridgeTokensViaSquid(bridgeData, squidData, {
                        value: value,
                        maxFeePerGas: maxFeePerGas,
                        maxPriorityFeePerGas: maxPriorityFeePerGas,
                    })];
            case 5:
                tx = _a.sent();
                return [4 /*yield*/, tx.wait()];
            case 6:
                _a.sent();
                return [2 /*return*/];
        }
    });
}); };
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
