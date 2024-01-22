// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { MultichainFacet } from "lifi/Facets/MultichainFacet.sol";

contract DeployMultichainFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "MultichainFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(MultichainFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
