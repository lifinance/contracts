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
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceFacet = exports.removeFacet = exports.addFacets = exports.addOrReplaceFacets = exports.FacetCutAction = exports.getSelectors = void 0;
var ethers_1 = require("ethers");
var hardhat_1 = require("hardhat");
function getSelectors(contract) {
    var selectors = contract.interface.fragments.reduce(function (acc, val) {
        if (val.type === 'function') {
            var sig = contract.interface.getSighash(val);
            acc.push(sig);
            return acc;
        }
        else {
            return acc;
        }
    }, []);
    return selectors;
}
exports.getSelectors = getSelectors;
exports.FacetCutAction = {
    Add: 0,
    Replace: 1,
    Remove: 2,
};
function addOrReplaceFacets(facets, diamondAddress, initContract, initData) {
    if (initContract === void 0) { initContract = ethers_1.constants.AddressZero; }
    if (initData === void 0) { initData = '0x'; }
    return __awaiter(this, void 0, void 0, function () {
        var loupe, cut, _i, facets_1, f, replaceSelectors, addSelectors, selectors, _a, selectors_1, s, addr;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, hardhat_1.ethers.getContractAt('IDiamondLoupe', diamondAddress)];
                case 1:
                    loupe = (_b.sent());
                    cut = [];
                    _i = 0, facets_1 = facets;
                    _b.label = 2;
                case 2:
                    if (!(_i < facets_1.length)) return [3 /*break*/, 8];
                    f = facets_1[_i];
                    replaceSelectors = [];
                    addSelectors = [];
                    selectors = getSelectors(f);
                    _a = 0, selectors_1 = selectors;
                    _b.label = 3;
                case 3:
                    if (!(_a < selectors_1.length)) return [3 /*break*/, 6];
                    s = selectors_1[_a];
                    return [4 /*yield*/, loupe.facetAddress(s)];
                case 4:
                    addr = _b.sent();
                    if (addr === ethers_1.constants.AddressZero) {
                        addSelectors.push(s);
                        return [3 /*break*/, 5];
                    }
                    if (addr.toLowerCase() !== f.address.toLowerCase()) {
                        replaceSelectors.push(s);
                    }
                    _b.label = 5;
                case 5:
                    _a++;
                    return [3 /*break*/, 3];
                case 6:
                    if (replaceSelectors.length) {
                        cut.push({
                            facetAddress: f.address,
                            action: exports.FacetCutAction.Replace,
                            functionSelectors: replaceSelectors,
                        });
                    }
                    if (addSelectors.length) {
                        cut.push({
                            facetAddress: f.address,
                            action: exports.FacetCutAction.Add,
                            functionSelectors: addSelectors,
                        });
                    }
                    _b.label = 7;
                case 7:
                    _i++;
                    return [3 /*break*/, 2];
                case 8:
                    if (!cut.length) {
                        console.log('No facets to add or replace.');
                        return [2 /*return*/];
                    }
                    console.log('Adding/Replacing facet(s)...');
                    return [4 /*yield*/, doCut(diamondAddress, cut, initContract, initData)];
                case 9:
                    _b.sent();
                    console.log('Done.');
                    return [2 /*return*/];
            }
        });
    });
}
exports.addOrReplaceFacets = addOrReplaceFacets;
function addFacets(facets, diamondAddress, initContract, initData) {
    if (initContract === void 0) { initContract = ethers_1.constants.AddressZero; }
    if (initData === void 0) { initData = '0x'; }
    return __awaiter(this, void 0, void 0, function () {
        var cut, _i, facets_2, f, selectors;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    cut = [];
                    for (_i = 0, facets_2 = facets; _i < facets_2.length; _i++) {
                        f = facets_2[_i];
                        selectors = getSelectors(f);
                        cut.push({
                            facetAddress: f.address,
                            action: exports.FacetCutAction.Add,
                            functionSelectors: selectors,
                        });
                    }
                    if (!cut.length) {
                        console.log('No facets to add or replace.');
                        return [2 /*return*/];
                    }
                    console.log('Adding facet(s)...');
                    return [4 /*yield*/, doCut(diamondAddress, cut, initContract, initData)];
                case 1:
                    _a.sent();
                    console.log('Done.');
                    return [2 /*return*/];
            }
        });
    });
}
exports.addFacets = addFacets;
function removeFacet(selectors, diamondAddress) {
    return __awaiter(this, void 0, void 0, function () {
        var cut;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    cut = [
                        {
                            facetAddress: ethers_1.constants.AddressZero,
                            action: exports.FacetCutAction.Remove,
                            functionSelectors: selectors,
                        },
                    ];
                    console.log('Removing facet...');
                    return [4 /*yield*/, doCut(diamondAddress, cut, ethers_1.constants.AddressZero, '0x')];
                case 1:
                    _a.sent();
                    console.log('Done.');
                    return [2 /*return*/];
            }
        });
    });
}
exports.removeFacet = removeFacet;
function replaceFacet(facet, diamondAddress, initContract, initData) {
    if (initContract === void 0) { initContract = ethers_1.constants.AddressZero; }
    if (initData === void 0) { initData = '0x'; }
    return __awaiter(this, void 0, void 0, function () {
        var selectors, cut;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    selectors = getSelectors(facet);
                    cut = [
                        {
                            facetAddress: facet.address,
                            action: exports.FacetCutAction.Replace,
                            functionSelectors: selectors,
                        },
                    ];
                    console.log('Replacing facet...');
                    return [4 /*yield*/, doCut(diamondAddress, cut, initContract, initData)];
                case 1:
                    _a.sent();
                    console.log('Done.');
                    return [2 /*return*/];
            }
        });
    });
}
exports.replaceFacet = replaceFacet;
function doCut(diamondAddress, cut, initContract, initData) {
    return __awaiter(this, void 0, void 0, function () {
        var cutter, tx, receipt;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, hardhat_1.ethers.getContractAt('IDiamondCut', diamondAddress)];
                case 1:
                    cutter = (_a.sent());
                    return [4 /*yield*/, cutter.diamondCut(cut, initContract, initData)];
                case 2:
                    tx = _a.sent();
                    console.log('Diamond cut tx: ', tx.hash);
                    return [4 /*yield*/, tx.wait()];
                case 3:
                    receipt = _a.sent();
                    if (!receipt.status) {
                        throw Error("Diamond upgrade failed: ".concat(tx.hash));
                    }
                    return [2 /*return*/];
            }
        });
    });
}
