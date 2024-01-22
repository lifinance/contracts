// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

contract DeployAllBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "AllBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(AllBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/allbridge.json");
        string memory json = vm.readFile(path);

        address allBridge = json.readAddress(
            string.concat(".", _network, ".allBridge")
        );

        return abi.encode(allBridge);
    }
}
