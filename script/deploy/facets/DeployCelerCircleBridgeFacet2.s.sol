// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerCircleBridgeFacet } from "lifi/Facets/CelerCircleBridgeFacet.sol";

contract DeployCelerCircleBridgeFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "CelerCircleBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(CelerCircleBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/celerCircle.json");
        string memory json = vm.readFile(path);

        address circleBridgeProxy = json.readAddress(
            string.concat(".", _network, ".circleBridgeProxy")
        );
        address usdc = json.readAddress(string.concat(".", _network, ".usdc"));

        return abi.encode(circleBridgeProxy, usdc);
    }
}
