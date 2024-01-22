// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { DeBridgeFacet } from "lifi/Facets/DeBridgeFacet.sol";

contract DeployDeBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "DeBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(DeBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/debridge.json");
        string memory json = vm.readFile(path);

        address deBridgeGate = json.readAddress(
            string.concat(".config.", _network, ".deBridgeGate")
        );

        return abi.encode(deBridgeGate);
    }
}
