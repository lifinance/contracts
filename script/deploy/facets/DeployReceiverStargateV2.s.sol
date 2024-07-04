// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ReceiverStargateV2 } from "lifi/Periphery/ReceiverStargateV2.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ReceiverStargateV2") {}

    function run()
        public
        returns (ReceiverStargateV2 deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ReceiverStargateV2(
            deploy(type(ReceiverStargateV2).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
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

        // obtain address of LayerZero's EndPointV2 contract in current network from config file
        string memory path = string.concat(root, "/config/stargate.json");
        string memory json = vm.readFile(path);

        address endpointV2 = json.readAddress(
            string.concat(".endpointV2.", network)
        );
        address tokenMessaging = json.readAddress(
            string.concat(".tokenMessaging.", network)
        );

        // get Executor address from deploy log
        path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);
        address executor = json.readAddress(".Executor");

        return
            abi.encode(
                refundWalletAddress,
                executor,
                tokenMessaging,
                endpointV2,
                100000
            );
    }
}
