// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiTimelockController } from "lifi/Security/LiFiTimelockController.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LiFiTimelockController") {}

    function run()
        public
        returns (LiFiTimelockController deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = LiFiTimelockController(
            deploy(type(LiFiTimelockController).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );

        address diamondAddress = _getConfigContractAddress(
            path,
            ".LiFiDiamond"
        );

        // get minDelay from config file
        string memory timelockConfigPath = string.concat(
            root,
            "/config/timelockcontroller.json"
        );
        uint256 minDelay = timelockConfigPath.readUint(".minDelay");

        // get deployerWalletAddress from global.json
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );
        address deployerWalletAddress = globalConfigPath.readAddress(
            ".deployerWallet"
        );

        // get safeAddress from networks.json
        string memory networksConfigPath = string.concat(
            root,
            "/config/networks.json"
        );
        address safeAddress = _getConfigContractAddress(
            networksConfigPath,
            string.concat(".", network, ".safeAddress")
        );

        // get proposers (can also cancel) -> we only want out multisig (i.e. the admin) to be able to propose and cancel
        address[] memory proposers = new address[](1);
        proposers[0] = safeAddress;

        // get executors (we want out multisig as well as the deployer wallet to be able to execute)
        address[] memory executors = new address[](2);
        executors[0] = safeAddress;
        executors[1] = deployerWalletAddress;

        return
            abi.encode(
                minDelay,
                proposers,
                executors,
                safeAddress,
                diamondAddress
            );
    }
}
