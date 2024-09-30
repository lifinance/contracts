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
var arbitrum_staging_json_1 = __importDefault(require("../../deployments/arbitrum.staging.json"));
var swap_sdk_1 = require("@mayanfinance/swap-sdk");
var typechain_1 = require("../../typechain");
var ethers_1 = require("ethers");
var dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
var main = function () { return __awaiter(void 0, void 0, void 0, function () {
    var RPC_URL, PRIVATE_KEY, LIFI_ADDRESS, ARB_WETH_ADDRESS, POLYGON_USDT_ADDRESS, provider, signer, mayan, address, tx, quote, payload, iface, parsed, token, bridgeData, mayanData, gasPrice;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                RPC_URL = process.env.ETH_NODE_URI_ARBITRUM;
                PRIVATE_KEY = process.env.PRIVATE_KEY;
                LIFI_ADDRESS = arbitrum_staging_json_1.default.LiFiDiamond;
                ARB_WETH_ADDRESS = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
                POLYGON_USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
                provider = new ethers_1.ethers.providers.JsonRpcProvider(RPC_URL);
                signer = new ethers_1.ethers.Wallet(PRIVATE_KEY, provider);
                mayan = typechain_1.MayanFacet__factory.connect(LIFI_ADDRESS, provider);
                return [4 /*yield*/, signer.getAddress()];
            case 1:
                address = _a.sent();
                return [4 /*yield*/, (0, swap_sdk_1.fetchQuote)({
                        amount: 0.0010012345678,
                        fromToken: ARB_WETH_ADDRESS,
                        toToken: POLYGON_USDT_ADDRESS,
                        fromChain: 'arbitrum',
                        toChain: 'polygon',
                        slippageBps: 300,
                    })];
            case 2:
                quote = _a.sent();
                payload = (0, swap_sdk_1.getSwapFromEvmTxPayload)(quote[0], address, address, null, address, 42161, null, null);
                iface = typechain_1.IMayan__factory.createInterface();
                parsed = iface.parseTransaction({ data: payload.data });
                token = typechain_1.ERC20__factory.connect(ARB_WETH_ADDRESS, provider);
                bridgeData = {
                    transactionId: ethers_1.utils.randomBytes(32),
                    bridge: 'Mayan',
                    integrator: 'ACME Devs',
                    referrer: '0x0000000000000000000000000000000000000000',
                    sendingAssetId: ARB_WETH_ADDRESS,
                    receiver: address,
                    minAmount: ethers_1.utils.parseUnits('10', 6),
                    destinationChainId: 137,
                    hasSourceSwaps: false,
                    hasDestinationCall: false,
                };
                mayanData = {
                    mayanProtocol: parsed.args.mayanProtocol,
                    protocolData: parsed.args.protocolData,
                    nonEVMReceiver: '0x0000000000000000000000000000000000000000000000000000000000000000',
                };
                console.info('Dev Wallet Address: ', address);
                console.info('Approving USDC...');
                return [4 /*yield*/, provider.getGasPrice()];
            case 3:
                gasPrice = _a.sent();
                return [4 /*yield*/, token
                        .connect(signer)
                        .approve(LIFI_ADDRESS, ethers_1.constants.MaxUint256, { gasPrice: gasPrice })];
            case 4:
                tx = _a.sent();
                return [4 /*yield*/, tx.wait()];
            case 5:
                _a.sent();
                console.info('Approved USDC');
                console.info('Bridging USDC...');
                return [4 /*yield*/, mayan
                        .connect(signer)
                        .startBridgeTokensViaMayan(bridgeData, mayanData, { gasPrice: gasPrice })];
            case 6:
                tx = _a.sent();
                return [4 /*yield*/, tx.wait()];
            case 7:
                _a.sent();
                console.info('Bridged USDC');
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
