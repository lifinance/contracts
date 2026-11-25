// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";

contract DeployScript is UpdateScriptBase {
    struct ChainIdConfig {
        uint256 chainId;
        uint256 deBridgeChainId;
    }

    /// @dev ChainIdConfig's fields in declared order, under a name no struct declares:
    ///      `forge test` would take the field order from a struct of the same name
    string internal constant CHAIN_ID_ROW_TYPE =
        "DeBridgeDlnChainIdRow(uint256 chainId,uint256 deBridgeChainId)";

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("DeBridgeDlnFacet");
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/debridgedln.json");
        json = vm.readFile(path);
        ChainIdConfig[] memory cidCfg = abi.decode(
            vm.parseJsonTypeArray(json, ".mappings", CHAIN_ID_ROW_TYPE),
            (ChainIdConfig[])
        );

        bytes memory callData = abi.encodeWithSelector(
            DeBridgeDlnFacet.initDeBridgeDln.selector, cidCfg
        );

        return callData;
    }
}
