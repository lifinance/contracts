// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LiFiDEXAggregator") {}

    function run()
        public
        returns (LiFiDEXAggregator deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LiFiDEXAggregator(
            deploy(type(LiFiDEXAggregator).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/global.json");

        address[] memory priviledgedUsers = new address[](1);
        priviledgedUsers[0] = _getConfigContractAddress(path, ".pauserWallet");

        // the original RouteProcessor4.sol is also deployed with address(0) for _bentoBox
        address withdrawWalletAddress = _getConfigContractAddress(
            path,
            ".withdrawWallet"
        );
        return abi.encode(address(0), priviledgedUsers, withdrawWalletAddress);
    }
}
