// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { PioneerFacet } from "lifi/Facets/PioneerFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("PioneerFacet") {}

    function run()
        public
        returns (PioneerFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = PioneerFacet(
            deploy(
                abi.encodePacked(
                    type(PioneerFacet).creationCode,
                    constructorArgs
                )
            )
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/pioneer.json");
        string memory json = vm.readFile(path);

        // Load the Pioneer EOA address
        // check if production or staging
        address pioneer;
        if (
            keccak256(abi.encodePacked(fileSuffix)) ==
            keccak256(abi.encodePacked("staging."))
        ) {
            pioneer = json.readAddress(string.concat(".pioneerEOAStaging"));
        } else {
            pioneer = json.readAddress(string.concat(".pioneerEOAProduction"));
        }

        return abi.encode(pioneer);
    }
}
