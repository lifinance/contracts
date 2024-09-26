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
var network_1 = require("../utils/network");
var chalk_1 = __importDefault(require("chalk"));
var msg = function (msg) {
    console.log(chalk_1.default.green(msg));
};
// Test process
// Approve USDC for LiFiDiamond for swapping
// Swap USDC -> DAI via uniswap on Mainnet
// Bridge DAI -> POS DAI via polygon native bridge
var LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0'; // staging LiFiDiamond address
var DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI address on mainnet
var POS_DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'; // POS DAI address on polygon
var USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC address on mainnet
var UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap router address on mainnet
var destinationChainId = 137; // Polygon chain id
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var jsonProvider, provider, wallet, walletAddress, lifi, token, uniswap, amountIn, amountOut, path, to, deadline, swapData, lifiData, bridgeData, allowance;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    jsonProvider = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('mainnet'));
                    provider = new ethers_1.providers.FallbackProvider([jsonProvider]);
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    wallet = wallet.connect(provider);
                    return [4 /*yield*/, wallet.getAddress()];
                case 1:
                    walletAddress = _a.sent();
                    lifi = typechain_1.PolygonBridgeFacet__factory.connect(LIFI_ADDRESS, wallet);
                    token = typechain_1.ERC20__factory.connect(USDC_ADDRESS, wallet);
                    uniswap = new ethers_1.Contract(UNISWAP_ADDRESS, [
                        'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
                    ]);
                    amountIn = ethers_1.utils.parseUnits('5', 6);
                    amountOut = ethers_1.utils.parseEther('4');
                    path = [USDC_ADDRESS, DAI_ADDRESS];
                    to = LIFI_ADDRESS // should be a checksummed recipient address
                    ;
                    deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time
                    ;
                    return [4 /*yield*/, uniswap.populateTransaction.swapTokensForExactTokens(amountOut, amountIn, path, to, deadline)];
                case 2:
                    swapData = _a.sent();
                    lifiData = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        integrator: 'ACME Devs',
                        referrer: ethers_1.constants.AddressZero,
                        sendingAssetId: USDC_ADDRESS,
                        receivingAssetId: POS_DAI_ADDRESS,
                        receiver: walletAddress,
                        destinationChainId: destinationChainId,
                        amount: amountOut,
                    };
                    bridgeData = {
                        assetId: DAI_ADDRESS,
                        amount: amountOut,
                        receiver: walletAddress,
                    };
                    return [4 /*yield*/, token.allowance(walletAddress, LIFI_ADDRESS)];
                case 3:
                    allowance = _a.sent();
                    if (!amountIn.gt(allowance)) return [3 /*break*/, 5];
                    return [4 /*yield*/, token.approve(lifi.address, amountIn)];
                case 4:
                    _a.sent();
                    msg('Token approved for swapping');
                    _a.label = 5;
                case 5: 
                // Call LiFi smart contract to start the bridge process -- WITH SWAP
                return [4 /*yield*/, lifi.swapAndStartBridgeTokensViaPolygonBridge(lifiData, [
                        {
                            sendingAssetId: USDC_ADDRESS,
                            approveTo: swapData.to,
                            receivingAssetId: DAI_ADDRESS,
                            fromAmount: amountIn,
                            callTo: swapData.to,
                            callData: swapData === null || swapData === void 0 ? void 0 : swapData.data,
                        },
                    ], bridgeData, {
                        gasLimit: '500000',
                    })];
                case 6:
                    // Call LiFi smart contract to start the bridge process -- WITH SWAP
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
main()
    .then(function () {
    console.error('Success');
    process.exit(0);
})
    .catch(function (error) {
    console.error('error');
    console.error(error);
    process.exit(1);
});
