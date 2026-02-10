// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "script/deploy/facets/utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SomeFacet } from "lifi/Facets/SomeFacet.sol";

/**
 * Violation: Deployment script in script/deploy/ that was modified but does NOT
 * have a corresponding update in script/deploy/zksync/.
 * 
 * Convention violation: If modifying a script in script/deploy/, you MUST check
 * and apply the same changes to script/deploy/zksync/.
 * 
 * This file represents a scenario where:
 * - A developer modified DeploySomeFacet.s.sol in script/deploy/facets/
 * - Added new logic, changed constructor args, or updated config paths
 * - But forgot to apply the same changes to script/deploy/zksync/DeploySomeFacet.zksync.s.sol
 * 
 * This violates the ZkSync Synchronization rule.
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

        // Example: New logic added here that wasn't synced to zksync version
        address router = _getConfigContractAddress(
            path,
            string.concat(".", network, ".router")
        );
        
        // Example: New config field added that zksync version doesn't have
        address newConfigField = _getConfigContractAddress(
            path,
            string.concat(".", network, ".newField")
        );

        return abi.encode(router, newConfigField);
    }
    
    // Violation: The corresponding file script/deploy/zksync/DeploySomeFacet.zksync.s.sol
    // was NOT updated with the same changes (newConfigField, etc.)
    // This breaks the ZkSync Synchronization requirement.
}
