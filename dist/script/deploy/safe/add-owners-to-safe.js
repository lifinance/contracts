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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var citty_1 = require("citty");
var viem_1 = require("viem");
var protocol_kit_1 = __importStar(require("@safe-global/protocol-kit"));
var api_kit_1 = __importDefault(require("@safe-global/api-kit"));
var ethers6_1 = require("ethers6");
var config_1 = require("./config");
var viemScriptHelpers_1 = require("../../utils/viemScriptHelpers");
var main = (0, citty_1.defineCommand)({
    meta: {
        name: 'propose-to-safe',
        description: 'Propose a transaction to a Gnosis Safe',
    },
    args: {
        network: {
            type: 'string',
            description: 'Network name',
            required: true,
        },
        rpcUrl: {
            type: 'string',
            description: 'RPC URL',
        },
        privateKey: {
            type: 'string',
            description: 'Private key of the signer',
            required: true,
        },
        owners: {
            type: 'string',
            description: 'List of new owners to add to the safe separated by commas',
            required: true,
        },
    },
    run: function (_a) {
        var args = _a.args;
        return __awaiter(this, void 0, void 0, function () {
            var network, privateKey, chain, config, safeService, safeAddress, rpcUrl, provider, signer, ethAdapter, protocolKit, owners, nextNonce, info, _i, owners_1, o, owner, existingOwners, safeTransaction, _b, _c, senderAddress, safeTxHash, signature, _d, _e;
            var _f, _g;
            return __generator(this, function (_h) {
                switch (_h.label) {
                    case 0:
                        network = args.network, privateKey = args.privateKey;
                        chain = (0, viemScriptHelpers_1.getViemChainForNetworkName)(network);
                        config = {
                            chainId: BigInt(chain.id),
                            txServiceUrl: config_1.safeApiUrls[network],
                        };
                        safeService = new api_kit_1.default(config);
                        safeAddress = (0, viem_1.getAddress)(config_1.safeAddresses[network]);
                        rpcUrl = args.rpcUrl || chain.rpcUrls.default.http[0];
                        provider = new ethers6_1.ethers.JsonRpcProvider(rpcUrl);
                        signer = new ethers6_1.ethers.Wallet(args.privateKey, provider);
                        ethAdapter = new protocol_kit_1.EthersAdapter({
                            ethers: ethers6_1.ethers,
                            signerOrProvider: signer,
                        });
                        return [4 /*yield*/, protocol_kit_1.default.create({
                                ethAdapter: ethAdapter,
                                safeAddress: safeAddress,
                                contractNetworks: (0, config_1.getSafeUtilityContracts)(chain.id),
                            })];
                    case 1:
                        protocolKit = _h.sent();
                        owners = String(args.owners).split(',');
                        return [4 /*yield*/, safeService.getNextNonce(safeAddress)];
                    case 2:
                        nextNonce = _h.sent();
                        info = safeService.getSafeInfo(safeAddress);
                        _i = 0, owners_1 = owners;
                        _h.label = 3;
                    case 3:
                        if (!(_i < owners_1.length)) return [3 /*break*/, 13];
                        o = owners_1[_i];
                        owner = (0, viem_1.getAddress)(o);
                        return [4 /*yield*/, protocolKit.getOwners()];
                    case 4:
                        existingOwners = _h.sent();
                        if (existingOwners.includes(owner)) {
                            console.info('Owner already exists', owner);
                            return [3 /*break*/, 12];
                        }
                        _c = (_b = protocolKit).createAddOwnerTx;
                        _f = {
                            ownerAddress: owner
                        };
                        return [4 /*yield*/, info];
                    case 5: return [4 /*yield*/, _c.apply(_b, [(_f.threshold = (_h.sent()).threshold,
                                _f), {
                                nonce: nextNonce,
                            }])];
                    case 6:
                        safeTransaction = _h.sent();
                        return [4 /*yield*/, signer.getAddress()];
                    case 7:
                        senderAddress = _h.sent();
                        return [4 /*yield*/, protocolKit.getTransactionHash(safeTransaction)];
                    case 8:
                        safeTxHash = _h.sent();
                        return [4 /*yield*/, protocolKit.signHash(safeTxHash)];
                    case 9:
                        signature = _h.sent();
                        console.info('Adding owner', owner);
                        console.info('Signer Address', senderAddress);
                        console.info('Safe Address', safeAddress);
                        _e = (_d = safeService).proposeTransaction;
                        _g = {};
                        return [4 /*yield*/, protocolKit.getAddress()];
                    case 10: 
                    // Propose transaction to the service
                    return [4 /*yield*/, _e.apply(_d, [(_g.safeAddress = _h.sent(),
                                _g.safeTransactionData = safeTransaction.data,
                                _g.safeTxHash = safeTxHash,
                                _g.senderAddress = senderAddress,
                                _g.senderSignature = signature.data,
                                _g)])];
                    case 11:
                        // Propose transaction to the service
                        _h.sent();
                        console.info('Transaction proposed');
                        nextNonce++;
                        _h.label = 12;
                    case 12:
                        _i++;
                        return [3 /*break*/, 3];
                    case 13: return [2 /*return*/];
                }
            });
        });
    },
});
(0, citty_1.runMain)(main);
