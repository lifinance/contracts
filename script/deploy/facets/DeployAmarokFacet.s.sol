// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AmarokFacet } from "lifi/Facets/AmarokFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AmarokFacet") {}

    function run()
        public
        returns (AmarokFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/amarok.json"
        );
        string memory json = vm.readFile(path);
        address connextHandler = json.readAddress(
            string.concat(".", network, ".connextHandler")
        );

        constructorArgs = abi.encode(connextHandler);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (AmarokFacet(payable(predicted)), constructorArgs);
        }

        deployed = AmarokFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(AmarokFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
