// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerCircleBridgeFacet } from "lifi/Facets/CelerCircleBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CelerCircleBridgeFacet") {}

    function run()
        public
        returns (CelerCircleBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/celerCircle.json"
        );
        string memory json = vm.readFile(path);
        address circleBridgeProxy = json.readAddress(
            string.concat(".", network, ".circleBridgeProxy")
        );
        address usdc = json.readAddress(string.concat(".", network, ".usdc"));

        constructorArgs = abi.encode(circleBridgeProxy, usdc);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (
                CelerCircleBridgeFacet(payable(predicted)),
                constructorArgs
            );
        }

        deployed = CelerCircleBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(CelerCircleBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
