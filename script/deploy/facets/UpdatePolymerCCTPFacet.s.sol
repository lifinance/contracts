// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";

contract DeployScript is UpdateScriptBase {
    /// @dev PolymerCCTPFacet.ChainIdConfig's fields in declared order, under a name no struct
    ///      declares: `forge test` would take the field order from a struct of the same name
    string internal constant CHAIN_ID_ROW_TYPE =
        "PolymerCCTPChainIdRow(uint256 chainId,uint32 domainId)";

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("PolymerCCTPFacet");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        PolymerCCTPFacet polymer;
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = PolymerCCTPFacet.initPolymerCCTP.selector;
        // Exclude USDC() to prevent conflict with CelerCircleBridgeFacet (Celer's USDC() remains active)
        excludes[1] = polymer.USDC.selector;
        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/polymercctp.json");
        json = vm.readFile(path);
        PolymerCCTPFacet.ChainIdConfig[] memory chainIdConfigs = abi.decode(
            vm.parseJsonTypeArray(json, ".mappings", CHAIN_ID_ROW_TYPE),
            (PolymerCCTPFacet.ChainIdConfig[])
        );

        return abi.encodeWithSelector(
            PolymerCCTPFacet.initPolymerCCTP.selector, chainIdConfigs
        );
    }
}
