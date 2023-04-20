// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

contract UpdateScriptBase is Script {
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

    constructor() {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");
        bool useDefaultDiamond = vm.envBool("USE_DEF_DIAMOND");

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
        cmd[0] = "scripts/contract-selectors.sh";
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
}
