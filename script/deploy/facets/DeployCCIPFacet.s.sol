// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CCIPFacet } from "lifi/Facets/CCIPFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CCIPFacet") {}

    function run()
        public
        returns (CCIPFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/ccip.json"
        );
        string memory json = vm.readFile(path);
        address example = json.readAddress(
            string.concat(".", network, ".example")
        );

        constructorArgs = abi.encode(example);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CCIPFacet(payable(predicted)), constructorArgs);
        }

        deployed = CCIPFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(type(CCIPFacet).creationCode, constructorArgs)
                )
            )
        );

        vm.stopBroadcast();
    }
}
