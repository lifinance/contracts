// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "script/deploy/facets/utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SomeFacet } from "lifi/Facets/SomeFacet.sol";

/**
 * Violation: Script file does NOT follow the naming pattern Deploy*.s.sol or Update*.s.sol.
 * 
 * Convention violation: Deployment scripts MUST follow the pattern:
 * - Deploy*.s.sol for deployment scripts
 * - Update*.s.sol for update scripts
 * 
 * This file is named BadNamingPattern.s.sol instead of DeploySomeFacet.s.sol,
 * which violates the naming convention.
 */
contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SomeFacet") {}

    function run()
        public
        returns (SomeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();
        deployed = SomeFacet(deploy(type(SomeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/someFacet.json");
        string memory json = vm.readFile(path);
        
        address router = _getConfigContractAddress(
            path,
            string.concat(".", network, ".router")
        );

        return abi.encode(router);
    }
}
