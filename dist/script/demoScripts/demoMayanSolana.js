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
var bsc_staging_json_1 = __importDefault(require("../../deployments/bsc.staging.json"));
var swap_sdk_1 = require("@mayanfinance/swap-sdk");
var ethers_1 = require("ethers");
var typechain_1 = require("../../typechain");
var ethers_2 = require("ethers");
var dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
var main = function () { return __awaiter(void 0, void 0, void 0, function () {
    var RPC_URL, PRIVATE_KEY, LIFI_ADDRESS, BSC_USDT_ADDRESS, provider, signer, mayan, deadline, address, tx, quote, payload, iface, parsed, token, bridgeData, mayanData, gasPrice;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                RPC_URL = process.env.ETH_NODE_URI_BSC;
                PRIVATE_KEY = process.env.PRIVATE_KEY;
                LIFI_ADDRESS = bsc_staging_json_1.default.LiFiDiamond;
                BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
                provider = new ethers_2.ethers.providers.JsonRpcProvider(RPC_URL);
                signer = new ethers_2.ethers.Wallet(PRIVATE_KEY, provider);
                mayan = typechain_1.MayanFacet__factory.connect(LIFI_ADDRESS, provider);
                deadline = Math.floor(Date.now() / 1000) + 60 * 10 // 10 minutes from the current Unix time
                ;
                return [4 /*yield*/, signer.getAddress()];
            case 1:
                address = _a.sent();
                return [4 /*yield*/, (0, swap_sdk_1.fetchQuote)({
                        amount: 10,
                        fromToken: BSC_USDT_ADDRESS,
                        toToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                        fromChain: 'bsc',
                        toChain: 'solana',
                        slippage: 3,
                    })];
            case 2:
                quote = _a.sent();
                return [4 /*yield*/, (0, swap_sdk_1.getSwapFromEvmTxPayload)(quote, '6AUWsSCRFSCbrHKH9s84wfzJXtD6mNzAHs11x6pGEcmJ', deadline, null, address, 56, provider)];
            case 3:
                payload = _a.sent();
                iface = typechain_1.IMayan__factory.createInterface();
                parsed = iface.parseTransaction({ data: payload.data });
                token = typechain_1.ERC20__factory.connect(BSC_USDT_ADDRESS, provider);
                bridgeData = {
                    transactionId: ethers_2.utils.randomBytes(32),
                    bridge: 'Mayan',
                    integrator: 'ACME Devs',
                    referrer: '0x0000000000000000000000000000000000000000',
                    sendingAssetId: BSC_USDT_ADDRESS,
                    receiver: '0x11f111f111f111F111f111f111F111f111f111F1',
                    minAmount: ethers_2.utils.parseEther('10'),
                    destinationChainId: 1151111081099710,
                    hasSourceSwaps: false,
                    hasDestinationCall: false,
                };
                mayanData = {
                    mayanAddr: parsed.args.recipient.mayanAddr,
                    referrer: ethers_2.utils.hexZeroPad('0x', 32),
                    tokenOutAddr: parsed.args.tokenOutAddr,
                    receiver: parsed.args.recipient.destAddr,
                    swapFee: parsed.args.relayerFees.swapFee,
                    redeemFee: parsed.args.relayerFees.redeemFee,
                    refundFee: parsed.args.relayerFees.refundFee,
                    transferDeadline: parsed.args.criteria.transferDeadline,
                    swapDeadline: parsed.args.criteria.swapDeadline,
                    amountOutMin: parsed.args.criteria.amountOutMin,
                    unwrap: parsed.args.criteria.unwrap,
                    gasDrop: parsed.args.criteria.gasDrop,
                };
                console.info('Dev Wallet Address: ', address);
                console.info('Approving USDT...');
                return [4 /*yield*/, provider.getGasPrice()];
            case 4:
                gasPrice = _a.sent();
                return [4 /*yield*/, token
                        .connect(signer)
                        .approve(LIFI_ADDRESS, ethers_1.constants.MaxUint256, { gasPrice: gasPrice })];
            case 5:
                tx = _a.sent();
                return [4 /*yield*/, tx.wait()];
            case 6:
                _a.sent();
                console.info('Approved USDT');
                console.info('Bridging USDT...');
                return [4 /*yield*/, mayan
                        .connect(signer)
                        .startBridgeTokensViaMayan(bridgeData, mayanData, { gasPrice: gasPrice })];
            case 7:
                tx = _a.sent();
                return [4 /*yield*/, tx.wait()];
            case 8:
                _a.sent();
                console.info('Bridged USDT');
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
