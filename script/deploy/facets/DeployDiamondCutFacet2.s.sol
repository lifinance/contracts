// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployDiamondCutFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "DiamondCutFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(DiamondCutFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
