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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var rest_1 = require("@octokit/rest");
var citty_1 = require("citty");
var OWNER = 'lifinance';
var REPO = 'contracts';
var main = (0, citty_1.defineCommand)({
    meta: {
        name: 'verify-approvals',
        description: 'Checks that a PR has the correct amount of approvals',
    },
    args: {
        branch: {
            type: 'string',
            description: 'The current branch',
        },
        token: {
            type: 'string',
            description: 'Github access token',
        },
        facets: {
            type: 'string',
            description: 'List of facets that should be part of this PR',
        },
    },
    run: function (_a) {
        var args = _a.args;
        return __awaiter(this, void 0, void 0, function () {
            var octokit, facets, pr, files, _i, facets_1, facet, scTeam, auditors, approvals, scApproved, auditorApproved, _b, scTeam_1, dev, _c, auditors_1, auditor;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        octokit = new rest_1.Octokit({ auth: args.token });
                        facets = args.facets.split('\n');
                        return [4 /*yield*/, getOpenPRsForBranch(octokit, args.branch, args.token)
                            // Fetch files related to this PR
                        ];
                    case 1:
                        pr = _d.sent();
                        return [4 /*yield*/, getFilesInPR(octokit, pr[0].number)];
                    case 2:
                        files = _d.sent();
                        for (_i = 0, facets_1 = facets; _i < facets_1.length; _i++) {
                            facet = facets_1[_i];
                            if (!(files === null || files === void 0 ? void 0 : files.includes("src/Facets/".concat(facet, ".sol")))) {
                                console.error("".concat(facet, " is not included in this PR"));
                            }
                        }
                        return [4 /*yield*/, getTeamMembers(octokit, 'smartcontract')
                            // Get auditors team members
                        ];
                    case 3:
                        scTeam = _d.sent();
                        return [4 /*yield*/, getTeamMembers(octokit, 'auditors')];
                    case 4:
                        auditors = _d.sent();
                        if (!(scTeam === null || scTeam === void 0 ? void 0 : scTeam.length) || !(auditors === null || auditors === void 0 ? void 0 : auditors.length)) {
                            console.error('Team members not configured correctly');
                        }
                        return [4 /*yield*/, getPRApprovers(octokit, pr[0].number, args.token)];
                    case 5:
                        approvals = _d.sent();
                        if (!(approvals === null || approvals === void 0 ? void 0 : approvals.length)) {
                            console.error('No approvals');
                        }
                        auditorApproved = false;
                        for (_b = 0, scTeam_1 = scTeam; _b < scTeam_1.length; _b++) {
                            dev = scTeam_1[_b];
                            if (approvals === null || approvals === void 0 ? void 0 : approvals.includes(dev)) {
                                scApproved = true;
                                break;
                            }
                        }
                        for (_c = 0, auditors_1 = auditors; _c < auditors_1.length; _c++) {
                            auditor = auditors_1[_c];
                            if (approvals === null || approvals === void 0 ? void 0 : approvals.includes(auditor)) {
                                auditorApproved = true;
                                break;
                            }
                        }
                        if (!scApproved || !auditorApproved) {
                            console.error('Missing required approvals');
                        }
                        process.stdout.write('OK');
                        return [2 /*return*/];
                }
            });
        });
    },
});
(0, citty_1.runMain)(main);
var getOpenPRsForBranch = function (octokit, branch, token) { return __awaiter(void 0, void 0, void 0, function () {
    var pullRequests, page, fetching, pullsForPage, openPrsForBranch;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                pullRequests = [];
                page = 1;
                fetching = true;
                _a.label = 1;
            case 1:
                if (!fetching) return [3 /*break*/, 3];
                return [4 /*yield*/, octokit.pulls.list({
                        owner: OWNER,
                        repo: REPO,
                        state: 'open',
                        per_page: 100,
                        page: page++,
                    })];
            case 2:
                pullsForPage = (_a.sent()).data;
                if (pullsForPage.length === 0) {
                    fetching = false;
                    return [3 /*break*/, 3];
                }
                pullRequests = __spreadArray(__spreadArray([], pullRequests, true), pullsForPage, true);
                return [3 /*break*/, 1];
            case 3:
                openPrsForBranch = pullRequests.filter(function (pr) { return pr.head.ref === branch; });
                return [2 /*return*/, openPrsForBranch];
        }
    });
}); };
var getPRApprovers = function (octokit, pull_number, token) { return __awaiter(void 0, void 0, void 0, function () {
    var reviews, approvers, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, octokit.pulls.listReviews({
                        owner: OWNER,
                        repo: REPO,
                        pull_number: pull_number,
                    })];
            case 1:
                reviews = (_a.sent()).data;
                approvers = reviews
                    .filter(function (review) { return review.state === 'APPROVED'; })
                    .map(function (review) { var _a; return (_a = review.user) === null || _a === void 0 ? void 0 : _a.login; });
                return [2 /*return*/, approvers];
            case 2:
                error_1 = _a.sent();
                console.error(error_1);
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); };
var getFilesInPR = function (octokit, pull_number) { return __awaiter(void 0, void 0, void 0, function () {
    var result, error_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, octokit.rest.pulls.listFiles({
                        owner: OWNER,
                        repo: REPO,
                        pull_number: pull_number,
                    })];
            case 1:
                result = _a.sent();
                return [2 /*return*/, result.data
                        .filter(function (file) { return file.status === 'modified' || file.status === 'added'; })
                        .map(function (file) { return file.filename; })];
            case 2:
                error_2 = _a.sent();
                console.error(error_2);
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); };
var getTeamMembers = function (octokit, team) { return __awaiter(void 0, void 0, void 0, function () {
    var response, error_3;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, octokit.teams.listMembersInOrg({
                        org: OWNER,
                        team_slug: team,
                    })];
            case 1:
                response = _a.sent();
                return [2 /*return*/, response.data.map(function (t) { return t.login; }) || []];
            case 2:
                error_3 = _a.sent();
                console.error(error_3);
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); };
