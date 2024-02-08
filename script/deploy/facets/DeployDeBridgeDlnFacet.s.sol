// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("DeBridgeDlnFacet") {}

    function run()
        public
        returns (DeBridgeDlnFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/deBridgeDln.json"
        );
        string memory json = vm.readFile(path);
        address example = json.readAddress(
            string.concat(".", network, ".example")
        );

        constructorArgs = abi.encode(example);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (DeBridgeDlnFacet(payable(predicted)), constructorArgs);
        }

        deployed = DeBridgeDlnFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(DeBridgeDlnFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
