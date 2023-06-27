// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ThorSwapFacet } from "lifi/Facets/ThorSwapFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ThorSwapFacet") {}

    function run()
        public
        returns (ThorSwapFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/thorswap.json"
        );
        string memory json = vm.readFile(path);
        address thorchainRouter = json.readAddress(
            string.concat(".", network, ".thorchainRouter")
        );

        constructorArgs = abi.encode(thorchainRouter);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (ThorSwapFacet(predicted), constructorArgs);
        }

        deployed = ThorSwapFacet(
            factory.deploy(
                salt,
                bytes.concat(type(ThorSwapFacet).creationCode, constructorArgs)
            )
        );

        vm.stopBroadcast();
    }
}
