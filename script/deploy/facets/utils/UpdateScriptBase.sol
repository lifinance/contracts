// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { console } from "forge-std/console.sol";

contract UpdateScriptBase is Script {
    struct FunctionSignature {
        string name;
        bytes sig;
    }

    using stdJson for string;

    address internal diamond;
    IDiamondCut.FacetCut[] internal cut;
    bytes4[] internal selectorsToReplace;
    bytes4[] internal selectorsToRemove;
    bytes4[] internal selectorsToAdd;
    DiamondCutFacet internal cutter;
    DiamondLoupeFacet internal loupe;
    uint256 internal deployerPrivateKey;
    string internal root;
    string internal network;
    string internal fileSuffix;
    string internal path;
    string internal json;
    bool internal noBroadcast = false;
    bool internal useDefaultDiamond;

    constructor() {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");
        useDefaultDiamond = vm.envBool("USE_DEF_DIAMOND");
        noBroadcast = vm.envBool("NO_BROADCAST");

        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);
        diamond = useDefaultDiamond
            ? json.readAddress(".LiFiDiamond")
            : json.readAddress(".LiFiDiamondImmutable");
        cutter = DiamondCutFacet(diamond);
        loupe = DiamondLoupeFacet(diamond);
    }

    function getSelectors(
        string memory _facetName,
        bytes4[] memory _exclude
    ) internal returns (bytes4[] memory selectors) {
        string[] memory cmd = new string[](3);
        cmd[0] = "script/deploy/facets/utils/contract-selectors.sh";
        cmd[1] = _facetName;
        string memory exclude;
        for (uint256 i; i < _exclude.length; i++) {
            exclude = string.concat(exclude, fromCode(_exclude[i]), " ");
        }
        cmd[2] = exclude;
        bytes memory res = vm.ffi(cmd);
        selectors = abi.decode(res, (bytes4[]));
    }

    function buildDiamondCut(
        bytes4[] memory newSelectors,
        address newFacet
    ) internal {
        address oldFacet;

        // Get selectors to add or replace
        for (uint256 i; i < newSelectors.length; i++) {
            if (loupe.facetAddress(newSelectors[i]) == address(0)) {
                selectorsToAdd.push(newSelectors[i]);
                // Don't replace if the new facet address is the same as the old facet address
            } else if (loupe.facetAddress(newSelectors[i]) != newFacet) {
                selectorsToReplace.push(newSelectors[i]);
                oldFacet = loupe.facetAddress(newSelectors[i]);
            }
        }

        // Get selectors to remove
        bytes4[] memory oldSelectors = loupe.facetFunctionSelectors(oldFacet);
        for (uint256 i; i < oldSelectors.length; i++) {
            bool found = false;
            for (uint256 j; j < newSelectors.length; j++) {
                if (oldSelectors[i] == newSelectors[j]) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                selectorsToRemove.push(oldSelectors[i]);
            }
        }

        // Build diamond cut
        if (selectorsToReplace.length > 0) {
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: newFacet,
                    action: IDiamondCut.FacetCutAction.Replace,
                    functionSelectors: selectorsToReplace
                })
            );
        }

        if (selectorsToRemove.length > 0) {
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(0),
                    action: IDiamondCut.FacetCutAction.Remove,
                    functionSelectors: selectorsToRemove
                })
            );
        }

        if (selectorsToAdd.length > 0) {
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: newFacet,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: selectorsToAdd
                })
            );
        }
    }

    function buildInitialCut(
        bytes4[] memory newSelectors,
        address newFacet
    ) internal {
        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: newFacet,
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: newSelectors
            })
        );
    }

    function toHexDigit(uint8 d) internal pure returns (bytes1) {
        if (0 <= d && d <= 9) {
            return bytes1(uint8(bytes1("0")) + d);
        } else if (10 <= uint8(d) && uint8(d) <= 15) {
            return bytes1(uint8(bytes1("a")) + d - 10);
        }
        revert();
    }

    function fromCode(bytes4 code) public pure returns (string memory) {
        bytes memory result = new bytes(10);
        result[0] = bytes1("0");
        result[1] = bytes1("x");
        for (uint256 i = 0; i < 4; ++i) {
            result[2 * i + 2] = toHexDigit(uint8(code[i]) / 16);
            result[2 * i + 3] = toHexDigit(uint8(code[i]) % 16);
        }
        return string(result);
    }

    function approveRefundWallet() internal {
        // get refund wallet address from global config file
        path = string.concat(root, "/config/global.json");
        json = vm.readFile(path);
        address refundWallet = json.readAddress(".refundWallet");

        // get function signatures that should be approved for refundWallet
        bytes memory rawConfig = json.parseRaw(".approvedSigsForRefundWallet");

        // parse raw data from config into FunctionSignature array
        FunctionSignature[] memory funcSigsToBeApproved = abi.decode(
            rawConfig,
            (FunctionSignature[])
        );

        // go through array with function signatures
        for (uint i = 0; i < funcSigsToBeApproved.length; i++) {
            // Register refundWallet as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSigsToBeApproved[i].sig),
                refundWallet,
                true
            );
        }
    }
}
