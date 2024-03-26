// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DeployDexManagerFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "DexManagerFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(DexManagerFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
