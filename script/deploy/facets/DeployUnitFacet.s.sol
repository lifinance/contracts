// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { UnitFacet } from "lifi/Facets/UnitFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("UnitFacet") {}

    function run()
        public
        returns (UnitFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = UnitFacet(deploy(type(UnitFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/unit.json");
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
