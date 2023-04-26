// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("OFTWrapperFacet") {}

    function run()
        public
        returns (OFTWrapperFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/oftwrapper.json"
        );
        string memory json = vm.readFile(path);
        address oftWrapper = json.readAddress(
            string.concat(".wrappers.", network)
        );

        if (oftWrapper == address(32)) {
            revert(
                string.concat(
                    "OFTWrapper address not found in config for network ",
                    network
                )
            );
        }

        constructorArgs = abi.encode(oftWrapper);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (OFTWrapperFacet(payable(predicted)), constructorArgs);
        }

        deployed = OFTWrapperFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(OFTWrapperFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
