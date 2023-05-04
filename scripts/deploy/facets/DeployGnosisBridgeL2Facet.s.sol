// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GnosisBridgeL2Facet } from "lifi/Facets/GnosisBridgeL2Facet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GnosisBridgeL2Facet") {}

    function run()
        public
        returns (GnosisBridgeL2Facet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/gnosis.json"
        );
        string memory json = vm.readFile(path);
        address xDaiBridge = json.readAddress(
            string.concat(".", network, ".xDaiBridge")
        );

        constructorArgs = abi.encode(xDaiBridge);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (GnosisBridgeL2Facet(payable(predicted)), constructorArgs);
        }

        deployed = GnosisBridgeL2Facet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(GnosisBridgeL2Facet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
