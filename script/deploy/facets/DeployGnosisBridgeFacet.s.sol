// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GnosisBridgeFacet } from "lifi/Facets/GnosisBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GnosisBridgeFacet") {}

    function run()
        public
        returns (GnosisBridgeFacet deployed, bytes memory constructorArgs)
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
            return (GnosisBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = GnosisBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(GnosisBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
