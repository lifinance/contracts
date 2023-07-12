// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SymbiosisFacet, ISymbiosisMetaRouter } from "lifi/Facets/SymbiosisFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SymbiosisFacet") {}

    function run()
    public
    returns (SymbiosisFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/symbiosis.json"
        );
        string memory json = vm.readFile(path);
        address metaRouter = json.readAddress(
            string.concat(".config.", network, ".metaRouter")
        );
        address gateway = json.readAddress(
            string.concat(".config.", network, ".gateway")
        );

        constructorArgs = abi.encode(metaRouter, gateway);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (SymbiosisFacet(payable(predicted)), constructorArgs);
        }

        if (networkSupportsCreate3(network)) {
            deployed = SymbiosisFacet(
                payable(
                    factory.deploy(
                        salt,
                        bytes.concat(
                            type(SymbiosisFacet).creationCode,
                            constructorArgs
                        )
                    )
                )
            );
        } else {
            deployed = new SymbiosisFacet(
                ISymbiosisMetaRouter(metaRouter),
                gateway
            );
        }

        vm.stopBroadcast();
    }
}
