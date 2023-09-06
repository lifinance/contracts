// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ScriptBase, console, console2 } from "./ScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";

contract UpdateScriptBase is ScriptBase {
    using stdJson for string;

    struct FunctionSignature {
        string name;
        bytes sig;
    }

    address internal diamond;
    IDiamondCut.FacetCut[] internal cut;
    bytes4[] internal selectorsToReplace;
    bytes4[] internal selectorsToRemove;
    bytes4[] internal selectorsToAdd;
    DiamondCutFacet internal cutter;
    DiamondLoupeFacet internal loupe;
    string internal path;
    string internal json;
    bool internal noBroadcast = false;
    bool internal useDefaultDiamond;

    constructor() {
        useDefaultDiamond = vm.envBool("USE_DEF_DIAMOND");
        noBroadcast = vm.envOr("NO_BROADCAST", false);

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

    function update(
        string memory name
    )
        internal
        virtual
        returns (address[] memory facets, bytes memory cutData)
    {
        console.log("update #1");
        address facet = json.readAddress(string.concat(".", name));

        bytes4[] memory excludes = getExcludes();
        bytes memory callData = getCallData();
        console.log("update #2");

        buildDiamondCut(getSelectors(name, excludes), facet);

        console.log("update #3");
        if (noBroadcast) {
            if (cut.length > 0) {
                cutData = abi.encodeWithSelector(
                    DiamondCutFacet.diamondCut.selector,
                    cut,
                    callData.length > 0 ? facet : address(0),
                    callData
                );
            }
            return (facets, cutData);
        }

        console.log("update #4");
        console.log("callData.length: ", callData.length);
        console.log("facet: ", facet);
        console.log("cut.length: ", cut.length);
        console.log("cut[0].facetAddress: ", cut[0].facetAddress);
        console.log("cut[0].action: ", uint256(cut[0].action));
        console.log(
            "cut[0].functionSelectors.length: ",
            cut[0].functionSelectors.length
        );
        console.log("calldata:");
        console2.logBytes(callData);

        vm.startBroadcast(deployerPrivateKey);

        if (cut.length > 0) {
            cutter.diamondCut(
                cut,
                callData.length > 0 ? facet : address(0),
                callData
            );
        }

        console.log("update #5");
        facets = loupe.facetAddresses();

        console.log("update #6");
        vm.stopBroadcast();
    }

    function getExcludes() internal virtual returns (bytes4[] memory) {}

    function getCallData() internal virtual returns (bytes memory) {}

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

        selectorsToAdd = new bytes4[](0);
        selectorsToReplace = new bytes4[](0);
        selectorsToRemove = new bytes4[](0);

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
        for (uint256 i = 0; i < funcSigsToBeApproved.length; i++) {
            // Register refundWallet as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSigsToBeApproved[i].sig),
                refundWallet,
                true
            );
        }
    }
}
