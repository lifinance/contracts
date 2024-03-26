// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { AccessManagerFacet } from "lifi/Facets/AccessManagerFacet.sol";

contract DeployAccessManagerFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "AccessManagerFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(AccessManagerFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
