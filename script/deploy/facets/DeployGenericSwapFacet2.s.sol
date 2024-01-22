// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";

contract DeployGenericSwapFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "GenericSwapFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(GenericSwapFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
