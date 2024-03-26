// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";

contract DeployHopFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "HopFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(HopFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
