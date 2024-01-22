// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";

contract DeployERC20Proxy2 is DeployScript {
    function _contractName() internal pure override returns (string memory) {
        return "ERC20Proxy";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(ERC20Proxy).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address _deployerAddress
    ) internal pure override returns (bytes memory) {
        return abi.encode(_deployerAddress);
    }
}
