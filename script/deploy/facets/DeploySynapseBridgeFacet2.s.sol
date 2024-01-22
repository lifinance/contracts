// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { SynapseBridgeFacet } from "lifi/Facets/SynapseBridgeFacet.sol";

contract DeploySynapseBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "SynapseBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(SynapseBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/synapse.json");
        string memory json = vm.readFile(path);

        address synapseRouter = json.readAddress(
            string.concat(".", _network, ".router")
        );

        return abi.encode(synapseRouter);
    }
}
