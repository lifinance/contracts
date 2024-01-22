// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { RelayerCelerIM } from "lifi/Periphery/RelayerCelerIM.sol";

contract DeployRelayerCelerIM2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "RelayerCelerIM";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(RelayerCelerIM).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory _fileSuffix,
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
        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        string memory path = string.concat(root, "/config/cbridge.json");
        string memory json = vm.readFile(path);

        address messageBus = json.readAddress(
            string.concat(".", _network, ".messageBus")
        );

        path = string.concat(
            root,
            "/deployments/",
            _network,
            ".",
            _fileSuffix,
            "json"
        );
        json = vm.readFile(path);

        address diamond = json.readAddress(".LiFiDiamond");

        return abi.encode(refundWalletAddress, messageBus, diamond);
    }
}
