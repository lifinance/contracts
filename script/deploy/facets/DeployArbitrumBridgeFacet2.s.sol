// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { ArbitrumBridgeFacet } from "lifi/Facets/ArbitrumBridgeFacet.sol";

contract DeployArbitrumBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "ArbitrumBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(ArbitrumBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/arbitrum.json");
        string memory json = vm.readFile(path);

        address gatewayRouter = json.readAddress(
            string.concat(".", _network, ".gatewayRouter")
        );
        address inbox = json.readAddress(
            string.concat(".", _network, ".inbox")
        );

        return abi.encode(gatewayRouter, inbox);
    }
}
