// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { NEARIntentsFacet } from "lifi/Facets/NEARIntentsFacet.sol";

/// @title DeployNEARIntentsFacet
/// @author LI.FI (https://li.fi)
/// @notice Deployment script for NEARIntentsFacet
/// @custom:version 1.0.0
contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("NEARIntentsFacet") {}

    function run()
        public
        returns (NEARIntentsFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = NEARIntentsFacet(
            deploy(type(NEARIntentsFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/nearintents.json");
        string memory json = vm.readFile(path);

        // check if production or staging
        address backendSigner;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            backendSigner = json.readAddress(".staging.backendSigner");
        } else {
            backendSigner = json.readAddress(".production.backendSigner");
        }

        return abi.encode(backendSigner);
    }
}
