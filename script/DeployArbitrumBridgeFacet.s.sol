// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ArbitrumBridgeFacet } from "lifi/Facets/ArbitrumBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ArbitrumBridgeFacet") {}

    function run()
        public
        returns (ArbitrumBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/arbitrum.json"
        );
        string memory json = vm.readFile(path);
        address gatewayRouter = json.readAddress(
            string.concat(".", network, ".gatewayRouter")
        );
        address inbox = json.readAddress(
            string.concat(".", network, ".inbox")
        );

        constructorArgs = abi.encode(gatewayRouter, inbox);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (ArbitrumBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = ArbitrumBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(ArbitrumBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
