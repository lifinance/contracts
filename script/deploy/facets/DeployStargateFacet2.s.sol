// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployStargateFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "StargateFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(StargateFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/stargate.json");
        string memory json = vm.readFile(path);

        address stargateComposer = json.readAddress(
            string.concat(".composers.", _network)
        );

        return abi.encode(stargateComposer);
    }
}
