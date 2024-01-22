// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

contract DeployDiamondLoupeFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "DiamondLoupeFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(DiamondLoupeFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
