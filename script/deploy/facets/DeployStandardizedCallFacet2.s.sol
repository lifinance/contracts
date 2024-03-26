// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";

contract DeployStandardizedCallFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "StandardizedCallFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(StandardizedCallFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
