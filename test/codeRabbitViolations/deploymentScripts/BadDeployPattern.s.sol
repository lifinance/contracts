// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "script/deploy/facets/utils/DeployScriptBase.sol";
import { SomeFacet } from "lifi/Facets/SomeFacet.sol";

/**
 * Violation: Deployment script that does NOT use stdJson for configuration.
 * Instead, it hardcodes addresses and values directly in the code.
 * 
 * Convention violation: Deployment scripts MUST use JSON config via stdJson.
 * Pattern: Use Foundry Deploy*.s.sol/Update*.s.sol with JSON config via stdJson.
 */
contract DeployScript is DeployScriptBase {
    // Violation: Should use stdJson to read from config files, not hardcode values
    constructor() DeployScriptBase("SomeFacet") {}

    function run()
        public
        returns (SomeFacet deployed, bytes memory constructorArgs)
    {
        // Violation: Hardcoded address instead of reading from config JSON
        address router = 0x1234567890123456789012345678901234567890;
        
        // Violation: Hardcoded value instead of reading from config
        uint256 someValue = 1000;
        
        constructorArgs = abi.encode(router, someValue);
        
        deployed = SomeFacet(deploy(type(SomeFacet).creationCode));
    }

    // Violation: Should override getConstructorArgs() and use stdJson to read from config
    // function getConstructorArgs() internal override returns (bytes memory) {
    //     string memory path = string.concat(root, "/config/someFacet.json");
    //     string memory json = vm.readFile(path);
    //     address router = json.readAddress(string.concat(".", network, ".router"));
    //     return abi.encode(router);
    // }
}
