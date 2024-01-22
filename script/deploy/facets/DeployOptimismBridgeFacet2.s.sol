// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";

contract DeployOptimismBridgeFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "OptimismBridgeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(OptimismBridgeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
