// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";

contract DeployScript is UpdateScriptBase {
    /// @dev SupersetFacet.ChainIdConfig's fields in declared order, under a name no struct
    ///      declares: `forge test` would take the field order from a struct of the same name
    string internal constant CHAIN_ID_ROW_TYPE =
        "SupersetChainIdRow(uint256 chainId,uint32 lzEid)";

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("SupersetFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = SupersetFacet.initSuperset.selector;
        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/superset.json");
        json = vm.readFile(path);
        SupersetFacet.ChainIdConfig[] memory chainIdConfigs = abi.decode(
            vm.parseJsonTypeArray(json, ".mappings", CHAIN_ID_ROW_TYPE),
            (SupersetFacet.ChainIdConfig[])
        );

        return abi.encodeWithSelector(
            SupersetFacet.initSuperset.selector, chainIdConfigs
        );
    }
}
