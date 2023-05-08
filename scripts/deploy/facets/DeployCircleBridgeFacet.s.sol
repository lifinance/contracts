// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CircleBridgeFacet } from "lifi/Facets/CircleBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CircleBridgeFacet") {}

    function run()
        public
        returns (CircleBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/circle.json"
        );
        string memory json = vm.readFile(path);
        address tokenMessenger = json.readAddress(
            string.concat(".", network, ".tokenMessenger")
        );
        address usdc = json.readAddress(string.concat(".", network, ".usdc"));

        constructorArgs = abi.encode(tokenMessenger, usdc);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CircleBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = CircleBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(CircleBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
