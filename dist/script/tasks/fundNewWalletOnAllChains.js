"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
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
var citty_1 = require("citty");
var viem_1 = require("viem");
var accounts_1 = require("viem/accounts");
var network_1 = require("../../utils/network");
var gasZipChainIds_json_1 = __importDefault(require("../resources/gasZipChainIds.json"));
var ethers_1 = require("ethers");
var axios_1 = __importDefault(require("axios"));
var chains_1 = require("viem/chains");
var GAS_ZIP_ROUTER_MAINNET = '0x9e22ebec84c7e4c4bd6d4ae7ff6f4d436d6d8390';
var testnets = [
    'bsc-testnet',
    'lineatest',
    'mumbai',
    'sepolia',
    'localanvil',
    'virtualtestnet',
];
// this script is designed to be executed on mainnet (only)
// it will get a list of all networks we support (minus testnets) and send an equal USD
// amount worth of native tokens to each of these target networks using Gas.zip protocol
// call this script
// ts-node ./script/tasks/fundNewWalletOnAllChains.ts --privKeyFundingWallet "$PRIVATE_KEY" --receivingWallet "$PAUSER_WALLET" --doNotFundChains "[97,80001]" --fundAmountUSD "5"
var main = (0, citty_1.defineCommand)({
    meta: {
        name: 'fund-new-wallet-on-all-chains',
        description: 'Funds a wallet with equal value of native gas on all supported chains',
    },
    args: {
        privKeyFundingWallet: {
            type: 'string',
            description: 'Private key of the funding wallet',
            required: true,
        },
        receivingWallet: {
            type: 'string',
            description: 'Address of the receiving wallet',
            required: true,
        },
        doNotFundChains: {
            type: 'string',
            description: 'An array with chainIds that should not be funded',
            required: true,
        },
        fundAmountUSD: {
            type: 'string',
            description: 'The amount of USD that should be sent to every chain',
            required: true,
        },
    },
    run: function (_a) {
        var args = _a.args;
        return __awaiter(this, void 0, void 0, function () {
            var privKeyFundingWallet, receivingWallet, doNotFundChains, fundAmountUSD, fundingWallet, publicClient, walletClient, networks, amountUSDPerNetwork, amountRequiredUSD, ethPrice, _b, _c, amountRequiredNative, nativeBalance, _d, _e, chainIds, chainsBN, result, txHash;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        privKeyFundingWallet = args.privKeyFundingWallet, receivingWallet = args.receivingWallet, doNotFundChains = args.doNotFundChains, fundAmountUSD = args.fundAmountUSD;
                        fundingWallet = (0, accounts_1.privateKeyToAccount)("0x".concat(privKeyFundingWallet));
                        console.log("fundingWalletAddress: ".concat(fundingWallet.address));
                        console.log("receivingWallet: ".concat(receivingWallet));
                        console.log("doNotFundChains: ".concat(doNotFundChains));
                        console.log("fundAmountUSD: ".concat(fundAmountUSD));
                        publicClient = (0, viem_1.createPublicClient)({
                            chain: chains_1.mainnet,
                            transport: (0, viem_1.http)(),
                        });
                        walletClient = (0, viem_1.createWalletClient)({
                            chain: chains_1.mainnet,
                            transport: (0, viem_1.http)(),
                            account: fundingWallet,
                        });
                        networks = getAllTargetNetworks();
                        console.log("".concat(networks.length, " target networks identified"));
                        amountUSDPerNetwork = ethers_1.BigNumber.from(fundAmountUSD);
                        amountRequiredUSD = amountUSDPerNetwork.mul(networks.length);
                        console.log("USD amount required to fund all networks: $ ".concat(amountRequiredUSD.toString()));
                        _c = (_b = Math).round;
                        return [4 /*yield*/, getEthPrice()];
                    case 1:
                        ethPrice = _c.apply(_b, [_f.sent()]);
                        console.log("Current ETH price: $".concat(ethPrice));
                        amountRequiredNative = getNativeAmountRequired(amountRequiredUSD, ethPrice, 10);
                        console.log("Native amount required to fund all networks: ".concat(amountRequiredNative.toString()));
                        _e = (_d = ethers_1.BigNumber).from;
                        return [4 /*yield*/, publicClient.getBalance({
                                address: fundingWallet.address,
                            })];
                    case 2:
                        nativeBalance = _e.apply(_d, [_f.sent()]);
                        // make sure that balance is sufficient
                        if (nativeBalance.lt(amountRequiredNative))
                            throw new Error("Native balance of funding wallet is insufficient (required: ".concat(amountRequiredNative, ", available: ").concat(nativeBalance));
                        else
                            console.log('Funding wallet native balance is sufficient for this action: \nbalance: ${nativeBalance}, \nrequired: ${amountRequiredNative}');
                        chainIds = networks.map(function (network) { return network.id; });
                        console.log("ChainIds: [".concat(chainIds, "]"));
                        chainsBN = chainIds.reduce(function (p, c) { return (p << BigInt(8)) + BigInt(c); }, BigInt(0));
                        return [4 /*yield*/, publicClient.simulateContract({
                                account: fundingWallet,
                                address: GAS_ZIP_ROUTER_MAINNET,
                                abi: (0, viem_1.parseAbi)(['function deposit(uint256,address) external payable']),
                                functionName: 'deposit',
                                value: amountRequiredNative.toBigInt(),
                                args: [chainsBN, receivingWallet],
                            })];
                    case 3:
                        result = _f.sent();
                        console.dir(result, { depth: null, colors: true });
                        return [4 /*yield*/, walletClient.writeContract(result.request)];
                    case 4:
                        txHash = _f.sent();
                        console.log("Transaction successfully submitted: ".concat(txHash));
                        return [2 /*return*/];
                }
            });
        });
    },
});
var getNativeAmountRequired = function (dividend, divisor, precision) {
    if (precision > 10)
        throw new Error('max precision is 10 decimals');
    // calculate division result with precision
    var multiplier = ethers_1.BigNumber.from(10).pow(precision);
    var decimalResult = ethers_1.BigNumber.from(dividend).mul(multiplier).div(divisor);
    // adjust the amount to 10 ** 18
    var scaleFactor = ethers_1.BigNumber.from(10).pow(18 - precision);
    var nativeAmount = decimalResult.mul(scaleFactor);
    return nativeAmount;
};
// Function to get ETH price from CoinGecko
var getEthPrice = function () { return __awaiter(void 0, void 0, void 0, function () {
    var response, ethPrice, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, axios_1.default.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')];
            case 1:
                response = _a.sent();
                ethPrice = response.data.ethereum.usd;
                // console.log(`Current ETH price: $${ethPrice}`)
                return [2 /*return*/, ethPrice];
            case 2:
                error_1 = _a.sent();
                console.error('Error fetching ETH price:', error_1);
                throw error_1;
            case 3: return [2 /*return*/];
        }
    });
}); };
var getAllTargetNetworks = function () {
    // get a list of all target networks
    var allNetworks = (0, network_1.getAllNetworks)();
    // remove testnets
    var allProdNetworks = allNetworks.filter(function (network) { return !testnets.includes(network); });
    // get an array with Viem networks
    var allViemNetworks = allProdNetworks.map(function (network) {
        var chain = (0, network_1.getViemChainForNetworkName)(network);
        return __assign(__assign({}, chain), { nameLiFi: network });
    });
    // identify networks that gasZip does not support
    var gasZipChainIdsTyped = gasZipChainIds_json_1.default;
    var unsupportedNetworks = allViemNetworks.filter(function (network) { return !gasZipChainIdsTyped[network.id.toString()]; });
    if (unsupportedNetworks.length > 0)
        console.log("Viem does not support ".concat(unsupportedNetworks.length, " of our networks: [").concat(unsupportedNetworks.map(function (network) { return network.id; }), "]"));
    // identify networks that gasZip does not support
    var targetNetworks = allViemNetworks.filter(function (network) { return gasZipChainIdsTyped[network.id.toString()]; });
    return targetNetworks;
};
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
(0, citty_1.runMain)(main);
