// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { LiFuelFeeCollector } from "lifi/Periphery/LiFuelFeeCollector.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployLiFuelFeeCollector2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "LiFuelFeeCollector";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(LiFuelFeeCollector).creationCode;
    }

    function _getConstructorArgs(
        string calldata,
        string memory,
        address
    ) internal override returns (bytes memory) {
        // get path of global config file
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        // read file into json variable
        string memory globalConfigJson = vm.readFile(globalConfigPath);

        // extract refundWallet address
        address lifuelRebalanceWalletAddress = globalConfigJson.readAddress(
            ".lifuelRebalanceWallet"
        );

        return abi.encode(lifuelRebalanceWalletAddress);
    }
}
