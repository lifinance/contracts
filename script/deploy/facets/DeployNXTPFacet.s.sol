// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { NXTPFacet } from "lifi/Facets/NXTPFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("NXTPFacet") {}

    function run()
        public
        returns (NXTPFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/nxtp.json"
        );
        string memory json = vm.readFile(path);
        address txMgrAddress = json.readAddress(
            string.concat(".", network, ".txManagerAddress")
        );

        constructorArgs = abi.encode(txMgrAddress);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (NXTPFacet(predicted), constructorArgs);
        }

        deployed = NXTPFacet(
            factory.deploy(
                salt,
                bytes.concat(type(NXTPFacet).creationCode, constructorArgs)
            )
        );

        vm.stopBroadcast();
    }
}
