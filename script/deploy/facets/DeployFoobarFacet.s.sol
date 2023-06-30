// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { FoobarFacet } from "lifi/Facets/FoobarFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("FoobarFacet") {}

    function run()
        public
        returns (FoobarFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/foobar.json"
        );
        string memory json = vm.readFile(path);
        address example = json.readAddress(
            string.concat(".", network, ".example")
        );

        constructorArgs = abi.encode(example);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (FoobarFacet(payable(predicted)), constructorArgs);
        }

        deployed = FoobarFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(FoobarFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
