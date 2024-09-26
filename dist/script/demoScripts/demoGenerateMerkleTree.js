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
var merkletreejs_1 = __importDefault(require("merkletreejs"));
var gasRebates_json_1 = __importDefault(require("../resources/gasRebates.json"));
var fs_1 = __importDefault(require("fs"));
var utils_1 = require("ethers/lib/utils");
var OUTPUT_PATH = './script/output/outputMerkleProofs.json';
var createMerkleTree = function (claims) {
    // For each element : concatenate the two hex buffers
    // to a single one as this keccak256 implementation only
    // expects one input
    var leafNodes = claims.map(function (claim) {
        return (0, utils_1.keccak256)(Buffer.concat([
            Buffer.from(claim.account.replace('0x', ''), 'hex'),
            Buffer.from(claim.amount.replace('0x', ''), 'hex'),
        ]));
    });
    // create merkle tree from leafNodes
    var merkleTree = new merkletreejs_1.default(leafNodes, utils_1.keccak256, { sortPairs: true });
    return { merkleTree: merkleTree, leafNodes: leafNodes };
};
function getProof(claim, leafNodes, tree, allClaims) {
    // find index of the claim
    var index = allClaims.findIndex(function (item) { return item.account === claim.account && item.amount === claim.amount; });
    // throw error if claim could not be found
    if (index === -1)
        throw Error("could not find merkle proof for account ".concat(claim.account));
    // return merkle proof for claim
    return tree.getHexProof(leafNodes[index]);
}
var parseAccounts = function (accounts) {
    return Object.entries(accounts).map(function (_a) {
        var account = _a[0], amount = _a[1];
        return {
            account: account,
            amount: utils_1.defaultAbiCoder.encode(['uint256'], [amount]),
        };
    });
};
var processClaims = function (claims, leafNodes, tree) {
    return claims.map(function (claim) {
        var merkleProof = getProof(claim, leafNodes, tree, claims);
        return {
            account: claim.account,
            amount: claim.amount,
            merkleProof: merkleProof,
        };
    });
};
var processNetwork = function (network, claims, output) {
    // parse accounts into array
    var claimsArray = parseAccounts(claims);
    // create merkle tree
    var _a = createMerkleTree(claimsArray), merkleTree = _a.merkleTree, leafNodes = _a.leafNodes;
    // iterate over all claims and get merkle proof for each claim
    var claimsWithProof = processClaims(claimsArray, leafNodes, merkleTree);
    // create formatted output
    output[network] = {
        merkleRoot: merkleTree.getHexRoot().toString(),
        accounts: claimsWithProof,
    };
};
var main = function () { return __awaiter(void 0, void 0, void 0, function () {
    var output, claimsJson;
    return __generator(this, function (_a) {
        output = {};
        claimsJson = gasRebates_json_1.default;
        if (!claimsJson)
            throw Error('Input file invalid');
        // iterate over all networks
        Object.entries(claimsJson).forEach(function (_a) {
            var network = _a[0], accounts = _a[1];
            console.log("Now parsing network: ".concat(network));
            processNetwork(network, accounts, output);
        });
        // write formatted output to file
        fs_1.default.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
        console.log("Output file written to ".concat(OUTPUT_PATH));
        return [2 /*return*/];
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
