// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";

contract DeployOwnershipFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "OwnershipFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(OwnershipFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
