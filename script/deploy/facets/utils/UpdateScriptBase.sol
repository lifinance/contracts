// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ScriptBase } from "./ScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

contract UpdateScriptBase is ScriptBase {
    using stdJson for string;

    error InvalidHexDigit(uint8 d);

    struct FunctionSelector {
        string name;
        bytes selector;
    }

    struct Approval {
        address aTokenAddress;
        address bContractAddress;
    }

    address internal diamond;
    LibDiamond.FacetCut[] internal cut;
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
        address facet = json.readAddress(string.concat(".", name));
        bytes4[] memory excludes = getExcludes();
        bytes memory callData = getCallData();

        bytes4[] memory newSelectors = getSelectors(name, excludes);

        buildDiamondCut(newSelectors, facet);

        // prepare full diamondCut calldata and log for debugging purposes
        if (cut.length > 0) {
            cutData = abi.encodeWithSelector(
                DiamondCutFacet.diamondCut.selector,
                cut,
                callData.length > 0 ? facet : address(0),
                callData
            );

            emit log("DiamondCutCalldata: ");
            emit log_bytes(cutData);
        } else {
            // Initialize cutData as empty bytes if no changes needed
            cutData = "";
        }

        if (noBroadcast) {
            // Get current facets for return value even when not broadcasting
            facets = loupe.facetAddresses();
            return (facets, cutData);
        }

        vm.startBroadcast(deployerPrivateKey);

        if (cut.length > 0) {
            cutter.diamondCut(
                cut,
                callData.length > 0 ? facet : address(0),
                callData
            );
        }

        facets = loupe.facetAddresses();

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
            address existingFacet = loupe.facetAddress(newSelectors[i]);
            if (existingFacet == address(0)) {
                selectorsToAdd.push(newSelectors[i]);
                // Don't replace if the new facet address is the same as the old facet address
            } else if (existingFacet != newFacet) {
                selectorsToReplace.push(newSelectors[i]);
                oldFacet = existingFacet;
            }
        }

        // Get selectors to remove
        if (oldFacet != address(0)) {
            bytes4[] memory oldSelectors = loupe.facetFunctionSelectors(
                oldFacet
            );
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
        }

        // Build diamond cut
        if (selectorsToReplace.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: newFacet,
                    action: LibDiamond.FacetCutAction.Replace,
                    functionSelectors: selectorsToReplace
                })
            );
        }

        if (selectorsToRemove.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: address(0),
                    action: LibDiamond.FacetCutAction.Remove,
                    functionSelectors: selectorsToRemove
                })
            );
        }

        if (selectorsToAdd.length > 0) {
            cut.push(
                LibDiamond.FacetCut({
                    facetAddress: newFacet,
                    action: LibDiamond.FacetCutAction.Add,
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
            LibDiamond.FacetCut({
                facetAddress: newFacet,
                action: LibDiamond.FacetCutAction.Add,
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
        revert InvalidHexDigit(d);
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

        // get function selectors that should be approved for refundWallet
        bytes memory rawConfig = json.parseRaw(
            ".approvedSelectorsForRefundWallet"
        );

        emit log("rawConfig: ");
        emit log_bytes(rawConfig);

        // parse raw data from config into FunctionSelector array
        FunctionSelector[] memory funcSelectorsToBeApproved = abi.decode(
            rawConfig,
            (FunctionSelector[])
        );

        emit log("funcSelectorsToBeApproved: ");
        emit log_uint(funcSelectorsToBeApproved.length);

        // go through array with function selectors
        for (uint256 i = 0; i < funcSelectorsToBeApproved.length; i++) {
            emit log("funcSelectorsToBeApproved: ");
            emit log(funcSelectorsToBeApproved[i].name);
            // Register refundWallet as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSelectorsToBeApproved[i].selector),
                refundWallet,
                true
            );
        }
    }

    function approveDeployerWallet() internal {
        // get global config file
        path = string.concat(root, "/config/global.json");
        json = vm.readFile(path);

        // determine wallet address based on environment
        // if fileSuffix is empty, we're in production (use deployerWallet)
        // if fileSuffix is not empty (staging.), we're in staging (use devWallet)
        address executor;
        if (bytes(fileSuffix).length == 0) {
            executor = json.readAddress(".deployerWallet");
        } else {
            executor = json.readAddress(".devWallet");
        }

        // get function selectors that should be approved for executor
        bytes memory rawConfig = json.parseRaw(
            ".approvedSelectorsForDeployerWallet"
        );

        emit log("rawConfig: ");
        emit log_bytes(rawConfig);

        emit log("executor: ");
        emit log_address(executor);

        // parse raw data from config into FunctionSelector array
        FunctionSelector[] memory funcSelectorsToBeApproved = abi.decode(
            rawConfig,
            (FunctionSelector[])
        );

        emit log("funcSelectorsToBeApproved: ");
        emit log_uint(funcSelectorsToBeApproved.length);

        // go through array with function selectors
        for (uint256 i = 0; i < funcSelectorsToBeApproved.length; i++) {
            emit log("funcSelectorsToBeApproved: ");
            emit log(funcSelectorsToBeApproved[i].name);
            // Register executor as authorized wallet to call these functions
            AccessManagerFacet(diamond).setCanExecute(
                bytes4(funcSelectorsToBeApproved[i].selector),
                executor,
                true
            );
        }
    }
}
