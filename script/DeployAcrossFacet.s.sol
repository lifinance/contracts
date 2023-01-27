// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AcrossFacet") {}

    function run()
        public
        returns (AcrossFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/across.json"
        );
        string memory json = vm.readFile(path);
        address acrossSpokePool = json.readAddress(
            string.concat(".", network, ".acrossSpokePool")
        );
        address weth = json.readAddress(string.concat(".", network, ".weth"));

        constructorArgs = abi.encode(acrossSpokePool, weth);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (AcrossFacet(payable(predicted)), constructorArgs);
        }

        deployed = AcrossFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(AcrossFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
