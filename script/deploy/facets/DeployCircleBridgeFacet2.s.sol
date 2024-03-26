// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { CircleBridgeFacet } from "lifi/Facets/CircleBridgeFacet.sol";

contract DeployCircleBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "CircleBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(CircleBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/circle.json");
        string memory json = vm.readFile(path);

        address tokenMessenger = json.readAddress(
            string.concat(".", _network, ".tokenMessenger")
        );
        address usdc = json.readAddress(string.concat(".", _network, ".usdc"));

        return abi.encode(tokenMessenger, usdc);
    }
}
