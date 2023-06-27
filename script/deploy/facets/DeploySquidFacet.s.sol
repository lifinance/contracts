// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SquidFacet } from "lifi/Facets/SquidFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SquidFacet") {}

    function run()
        public
        returns (SquidFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/squid.json"
        );
        string memory json = vm.readFile(path);
        address router = json.readAddress(
            string.concat(".", network, ".router")
        );

        constructorArgs = abi.encode(router);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (SquidFacet(payable(predicted)), constructorArgs);
        }

        deployed = SquidFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(SquidFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
