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
Object.defineProperty(exports, "__esModule", { value: true });
var ethers_1 = require("ethers");
var typechain_1 = require("../typechain");
var network_1 = require("../../utils/network");
var deployment = __importStar(require("../export/deployments-staging.json"));
var LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address;
var anyTokenAddress = '0xd69b31c3225728cc57ddaf9be532a4ee1620be51';
var multichainRouter = '0x4f3Aff3A747fCADe12598081e80c6605A8be192F';
var tokenAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
var amountToSwap = '1';
var destinationChainId = 100;
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var wallet, provider1, provider, lifi, token, amount, lifiData, Multichain;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    wallet = ethers_1.Wallet.fromMnemonic(process.env.MNEMONIC);
                    provider1 = new ethers_1.providers.JsonRpcProvider((0, network_1.node_url)('polygon'));
                    provider = new ethers_1.providers.FallbackProvider([provider1]);
                    wallet = wallet.connect(provider);
                    lifi = typechain_1.MultichainFacet__factory.connect(LIFI_ADDRESS, wallet);
                    token = typechain_1.ERC20__factory.connect(tokenAddress, wallet);
                    amount = ethers_1.utils.parseUnits(amountToSwap, 6);
                    return [4 /*yield*/, token.approve(lifi.address, amount)];
                case 1:
                    _c.sent();
                    _a = {
                        transactionId: ethers_1.utils.randomBytes(32),
                        integrator: 'ACME Devs',
                        referrer: ethers_1.constants.AddressZero,
                        sendingAssetId: anyTokenAddress,
                        receivingAssetId: anyTokenAddress
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 2:
                    lifiData = (_a.receiver = _c.sent(),
                        _a.destinationChainId = destinationChainId,
                        _a.amount = amount.toString(),
                        _a);
                    _b = {
                        token: anyTokenAddress,
                        router: multichainRouter,
                        amount: amount
                    };
                    return [4 /*yield*/, wallet.getAddress()];
                case 3:
                    Multichain = (_b.recipient = _c.sent(),
                        _b.toChainId = destinationChainId,
                        _b);
                    return [4 /*yield*/, lifi.startBridgeTokensViaMultichain(lifiData, Multichain, {
                            gasLimit: 500000,
                        })];
                case 4:
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
