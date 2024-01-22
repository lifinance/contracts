// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";

contract DeployAmarokFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "AmarokFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(AmarokFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/amarok.json");
        string memory json = vm.readFile(path);

        address connextHandler = json.readAddress(
            string.concat(".", _network, ".connextHandler")
        );

        return abi.encode(connextHandler);
    }
}
