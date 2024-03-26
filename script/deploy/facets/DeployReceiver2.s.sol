// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";

contract DeployReceiver2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "Receiver";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(Receiver).creationCode;
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

        // obtain address of Stargate router in current network from config file
        string memory path = string.concat(root, "/config/stargate.json");
        string memory json = vm.readFile(path);

        address stargateRouter = json.readAddress(
            string.concat(".composers.", _network)
        );

        // obtain address of Amarok router in current network from config file
        path = string.concat(root, "/config/amarok.json");
        json = vm.readFile(path);

        address amarokRouter = json.readAddress(
            string.concat(".", _network, ".connextHandler")
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
        address executor = json.readAddress(".Executor");

        return
            abi.encode(
                refundWalletAddress,
                stargateRouter,
                amarokRouter,
                executor,
                100000
            );
    }
}
