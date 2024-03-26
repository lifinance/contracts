// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";

contract DeployWithdrawFacet2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "WithdrawFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(WithdrawFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal pure override returns (bytes memory) {}
}
