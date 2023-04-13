// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { RoninBridgeFacet } from "lifi/Facets/RoninBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("RoninBridgeFacet") {}

    function run()
        public
        returns (RoninBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/ronin.json"
        );
        string memory json = vm.readFile(path);
        address gateway = json.readAddress(
            string.concat(".", network, ".gateway")
        );

        constructorArgs = abi.encode(gateway);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (RoninBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = RoninBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(RoninBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
