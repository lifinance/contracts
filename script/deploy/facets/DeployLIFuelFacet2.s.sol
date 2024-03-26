// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { LIFuelFacet } from "lifi/Facets/LIFuelFacet.sol";

contract DeployLIFuelFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "LIFuelFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(LIFuelFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _name,
        string memory _symbol,
        address _owner
    ) internal pure override returns (bytes memory) {}
}
