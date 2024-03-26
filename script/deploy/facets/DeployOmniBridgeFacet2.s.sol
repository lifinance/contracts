// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { OmniBridgeFacet } from "lifi/Facets/OmniBridgeFacet.sol";

contract DeployOmniBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "OmniBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(OmniBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/omni.json");
        string memory json = vm.readFile(path);

        address foreignOmniBridge = json.readAddress(
            string.concat(".", _network, ".foreignOmniBridge")
        );
        address wethOmniBridge = json.readAddress(
            string.concat(".", _network, ".wethOmniBridge")
        );

        return abi.encode(foreignOmniBridge, wethOmniBridge);
    }
}
